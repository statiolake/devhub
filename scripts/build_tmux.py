#!/usr/bin/env python3
"""Build the tmux DevHub runs: the one it installs on a host, and the one in the app.

DevHub runs every terminal and every Agent inside tmux on the machine the
Workspace lives on — see docs/remote-ssh.md, "Agents and terminals on the
host". That is the whole of the design: a session survives the SSH connection,
the app reattaches to it after a restart, and `capture-pane` is how an Agent's
output is read. A host with no tmux is a host where none of that works.

The owner's own NAS is that host: Synology DSM, no tmux in the image, no
package manager worth the name and no sudo. Asking people to install one is
asking them to have root on a box they may not, and telling them "DevHub needs
tmux" is a sentence they can do nothing with. So DevHub publishes tmux the same
way it publishes the remote extension host, and installs it the same way: one
tarball per platform on a release of this repository, unpacked into the user's
own home directory on first use.

    ~/.devhub-server/tmux/<version>/bin/tmux

## Never the host's own tmux

DevHub does not look for a tmux on the machine and does not use one it finds.
tmux's control output — the `list-sessions` format, `capture-pane -e`,
`display-message -p` — differs between versions in ways that show up as an
Agent whose output is subtly wrong rather than as an error, and the adapter is
written against one version. One version, published here, is a version the
tests are about. See `docs/remote-ssh.md`, "tmux on the host".

## Static, because the host is unknown

The binary has to start on a Synology running a glibc from a decade ago and on
this year's Debian, and it may not assume a libevent or an ncurses is installed
anywhere. So everything is linked in: tmux, libevent and ncurses, all three
pinned below by version and by sha256.

The route is **musl**, via `musl-gcc` from Ubuntu's `musl-tools` — not glibc's
`-static`. A statically linked glibc still `dlopen`s the NSS modules of the
machine that built it the moment anything asks who the user is, and tmux does
exactly that at startup: `getpwuid` is how it finds the login shell and the
home directory. On a host whose glibc is older than the builder's, that is a
crash or a wrong shell with no message attached. musl resolves users out of
`/etc/passwd` in the same binary, so a musl static tmux has no libc on the host
at all and nothing to be older than.

An Alpine container would produce the same thing, and is the usual answer, but
it needs a container runtime on the runner and a second set of pins for the
base image. `musl-gcc` is one apt package, is present for both architectures,
and makes the build the same three `./configure && make` runs whether it runs
in CI or on a developer's own Ubuntu.

There is no cross-building: each target is built on a runner of its own
architecture, as the REH is, and this script refuses a target that is not the
machine it is running on rather than emit something it cannot execute.

`darwin-arm64` is the tmux inside DevHub.app, and is never published: hosts
are Linux. macOS has no static libc and Apple does not ship crt0.o, so it links
dynamically against libSystem — and against nothing else: libevent and ncurses
are linked in as on Linux, and `verify` refuses a binary that loads any library
from outside the OS. `apps/desktop/scripts/fetch-tmux.mjs` builds it on the Mac
that builds the app, and unpacks it into `out/tmux` as it unpacks the published
Linux tarball there for a Linux run: one build, one set of pins, for every tmux
DevHub runs (`apps/desktop/src/main/terminal/bundledTmux.ts`).

## Terminfo travels with it

A static ncurses has the terminfo *code* compiled in and no terminfo
*database*: that is a directory of files, read at runtime, and a bare host may
have none. So the tarball carries one — the handful of entries a DevHub
terminal actually names, compiled by the `tic` this build just made — and the
app points `TERMINFO` at it when it runs the binary. Nothing here reads the
host's database, and nothing here writes to it.

    scripts/build_tmux.py linux-x64 [--out-dir dist]
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

REPO_ROOT = Path(__file__).resolve().parent.parent

# What DevHub publishes, and the one target only the app carries. The two
# Linux pairs are what people SSH into (and what a Linux run of the app
# bundles); see the module docstring for why darwin-arm64 is not published.
TARGETS = ("linux-x64", "linux-arm64", "darwin-arm64")
PUBLISHED_TARGETS = ("linux-x64", "linux-arm64")


class Pinned(Protocol):
	"""Anything fetched by `fetch`: a file name, where it comes from, and its digest.

	A `Source` is one; so is one of bash's upstream patches (`build_bash.py`),
	which is a file to apply rather than a tree to build.
	"""

	@property
	def archive(self) -> str: ...

	@property
	def url(self) -> str: ...

	@property
	def sha256(self) -> str: ...


@dataclass(frozen=True)
class Source:
	"""One pinned upstream tarball.

	`sha256` is not a convenience. This build downloads three archives over the
	network and links their contents into a binary that DevHub then installs on
	other people's machines; a pin without a checksum is a promise that whoever
	serves the file today serves the same bytes as yesterday, and there is no
	reason to make that promise for anyone.
	"""

	name: str
	version: str
	url: str
	sha256: str
	# The upstream file that states the licence, relative to the unpacked
	# directory. It is shipped in the tarball because the binary contains their
	# code — tmux and libevent are ISC/BSD, ncurses is MIT-like, and all three
	# ask for the notice to travel with a redistribution.
	license_file: str

	@property
	def archive(self) -> str:
		return self.url.rsplit("/", 1)[-1]

	@property
	def unpacked(self) -> str:
		"""The single directory inside the archive, which every one of these names after itself."""
		return self.archive.removesuffix(".tar.gz")


# tmux 3.7c is the newest release that is not a candidate: 3.8-rc exists and is
# marked prerelease. The checksums are the ones GitHub publishes for the
# release assets and, for ncurses, the digest ftp.gnu.org and
# invisible-mirror.net both serve.
#
# Moving any of these three is a deliberate act: the release tag is named after
# the tmux version, so a bump publishes a new tarball beside the old one and
# every DevHub that was built before it goes on fetching the version it knows.
TMUX = Source(
	name="tmux",
	version="3.7c",
	url="https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
	sha256="7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
	license_file="COPYING",
)

LIBEVENT = Source(
	name="libevent",
	version="2.1.13-stable",
	url=(
		"https://github.com/libevent/libevent/releases/download/"
		"release-2.1.13-stable/libevent-2.1.13-stable.tar.gz"
	),
	sha256="f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c",
	license_file="LICENSE",
)

NCURSES = Source(
	name="ncurses",
	version="6.6",
	url="https://ftp.gnu.org/gnu/ncurses/ncurses-6.6.tar.gz",
	sha256="355b4cbbed880b0381a04c46617b7656e362585d52e9cf84a67e2009b749ff11",
	license_file="COPYING",
)

SOURCES = (NCURSES, LIBEVENT, TMUX)

# The terminfo entries the tarball carries. Two questions are being answered:
# what `TERM` DevHub sets on the client it attaches with, and what `TERM` tmux
# sets inside its own panes (`screen*` and `tmux*`, by tmux's `default-terminal`).
# The rest are there because a person will eventually run something in a pane
# that asks for one, and each costs about two kilobytes.
#
# A name missing from the database fails the build. Silently shipping a
# terminfo directory without `tmux-256color` in it would produce panes that
# render, mostly, and lose colour and cursor keys in ways nobody traces back
# here.
TERMINFO_ENTRIES = (
	"xterm",
	"xterm-color",
	"xterm-256color",
	"screen",
	"screen-256color",
	"tmux",
	"tmux-256color",
	"linux",
	"vt100",
	"ansi",
	"dumb",
)


# The macOS the darwin-arm64 tmux is built for: Electron's own minimum.
MACOSX_DEPLOYMENT_TARGET = "12.0"


def tarball_name(os_name: str, arch: str, version: str) -> str:
	"""What the app's download URL resolves to for this target.

	The same statement as `tmuxDownloadUrlTemplate` in
	`apps/desktop/product.json`, written twice —
	`build_tmux_test.py` checks that the two agree, because nothing at runtime
	does.
	"""
	return f"devhub-tmux-{os_name}-{arch}-{version}.tar.gz"


def release_tag(version: str) -> str:
	"""The release that holds every architecture's tarball for this tmux.

	Named after the tmux version rather than after a date or DevHub's commit:
	the artefact is a function of that version alone, the URL the app resolves has that
	version in it, and a release that never moves is a download an app built
	months ago still finds.
	"""
	return f"tmux-{version}"


def top_level_dir(os_name: str, arch: str) -> str:
	"""The single directory inside the tarball.

	One, so that the install can unpack with `tar --strip-components 1` into
	`~/.devhub-server/tmux/<version>/` and know what it got.
	"""
	return f"devhub-tmux-{os_name}-{arch}"


def host_target() -> str:
	"""The one target this machine can build, as `<os>-<arch>`."""
	os_name = {"darwin": "darwin", "linux": "linux"}.get(platform.system().lower())
	arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}.get(platform.machine())
	if os_name is None or arch is None:
		raise SystemExit(f"unsupported build machine: {platform.system()} {platform.machine()}")
	return f"{os_name}-{arch}"


def compiler(os_name: str) -> str:
	"""The C compiler that produces a binary the host does not have to match.

	On Linux that is `musl-gcc` and only `musl-gcc`; falling back to the
	system gcc would produce a glibc binary that works on the runner, works on
	the developer's laptop, and fails on the old host this whole script exists
	for. See the module docstring.
	"""
	if os_name != "linux":
		return "cc"
	musl = shutil.which("musl-gcc")
	if musl is None:
		raise SystemExit(
			"musl-gcc not found: install it with `sudo apt-get install -y musl-tools`. "
			"A glibc build is not a substitute — see the module docstring in "
			"scripts/build_tmux.py."
		)
	return musl


DOWNLOAD_ATTEMPTS = 6


def download(url: str, wait=time.sleep, opener=urllib.request.urlopen) -> bytes:
	"""The body of `url`, asked again when the server could not answer now.

	ftp.gnu.org and GitHub's release downloads answer 502, 503 or 504 now and
	then; one such answer failed a CI job that builds these from source. A
	5xx or a network error is asked again, five times more, twice as late
	each time: about a minute in all, as one spell of 504s outlasted 14 s.
	Any other answer is final. `fetch` checks what comes back against its
	pin, so asking again can never hand on different bytes.
	"""
	for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
		try:
			with opener(url) as response:
				return response.read()
		except urllib.error.HTTPError as error:
			if error.code < 500 or attempt == DOWNLOAD_ATTEMPTS:
				raise
			said = f"answered {error.code}"
		except urllib.error.URLError as error:
			if attempt == DOWNLOAD_ATTEMPTS:
				raise
			said = f"could not be reached ({error.reason})"
		print(f"  {url} {said}; asking again")
		wait(2 * 2 ** (attempt - 1))
	raise AssertionError("unreachable")


def fetch(source: Pinned, cache: Path) -> Path:
	"""Download one pinned archive, or reuse the one already verified.

	A cached file is checksummed again rather than trusted for being present:
	the cache is a directory on a build machine, and the pin is the only thing
	that says what these bytes are.
	"""
	cache.mkdir(parents=True, exist_ok=True)
	archive = cache / source.archive
	if not archive.exists():
		print(f"  downloading {source.archive}")
		archive.write_bytes(download(source.url))

	digest = hashlib.sha256(archive.read_bytes()).hexdigest()
	if digest != source.sha256:
		archive.unlink()
		raise SystemExit(
			f"{source.archive} is not what it is pinned to be:\n"
			f"  expected {source.sha256}\n"
			f"  got      {digest}\n"
			"The file has been deleted. Either upstream replaced a published "
			"release, or the download was tampered with; find out which before "
			"changing the pin."
		)
	return archive


def unpack(archive: Path, into: Path) -> Path:
	"""Unpack one upstream archive and return its single directory."""
	into.mkdir(parents=True, exist_ok=True)
	with tarfile.open(archive) as tar:
		tar.extractall(into, filter="data")
	return into / archive.name.removesuffix(".tar.gz")


def run(command: list[str], cwd: Path, env: dict[str, str]) -> None:
	print(f"  $ {' '.join(command)}")
	subprocess.run(command, cwd=cwd, env=env, check=True)


def build_env(os_name: str, prefix: Path) -> dict[str, str]:
	"""The environment every one of the three configures runs in.

	`PKG_CONFIG_PATH` and `PKG_CONFIG_LIBDIR` together are what stop tmux's
	configure from finding the *machine's* libevent and ncurses: the first adds
	the prefix, the second removes everywhere else. Without the second, a
	runner with `libevent-dev` installed produces a tmux linked against a
	libevent this script never checksummed.
	"""
	env = dict(os.environ)
	# The build machine's terminal is not a build input. ncurses' configure
	# reads `$TERMINFO` and compiles whatever it finds in as the binary's
	# default database — on this author's Mac that was a path inside
	# Ghostty.app — and, because the path was outside the prefix, it then
	# skipped installing a database at all. Both halves of that are silent.
	for leaked in ("TERMINFO", "TERMINFO_DIRS", "TERM"):
		env.pop(leaked, None)
	env["CC"] = compiler(os_name)
	env["PKG_CONFIG_PATH"] = str(prefix / "lib" / "pkgconfig")
	env["PKG_CONFIG_LIBDIR"] = str(prefix / "lib" / "pkgconfig")
	env["CPPFLAGS"] = f"-I{prefix / 'include'}"
	env["LDFLAGS"] = f"-L{prefix / 'lib'}"
	if os_name == "darwin":
		# The oldest macOS the app runs on (Electron's floor), not the build
		# machine's: a binary built on this year's macOS otherwise refuses an
		# older one.
		env["MACOSX_DEPLOYMENT_TARGET"] = MACOSX_DEPLOYMENT_TARGET
	return env


def build_ncurses(tree: Path, prefix: Path, env: dict[str, str]) -> None:
	"""Build the wide-character ncurses tmux links against, and its database.

	`--enable-widec` because tmux wants `ncursesw`; `--without-shared` and
	`--with-normal` because only the archive is ever linked; `--enable-pc-files`
	because tmux's configure asks pkg-config for it and takes the answer.

	The full terminfo database is installed into the build prefix on purpose,
	even though the tarball ships eleven entries: `infocmp` needs a database to
	read the eleven *out* of, and this is the one whose contents are pinned.
	"""
	run(
		[
			"./configure",
			f"--prefix={prefix}",
			"--without-shared",
			"--with-normal",
			"--enable-widec",
			"--enable-pc-files",
			f"--with-pkg-config-libdir={prefix / 'lib' / 'pkgconfig'}",
			# Where `make install` compiles the database to, and therefore
			# where `infocmp` reads the shipped entries out of. Stated rather
			# than defaulted: the default is whatever `$TERMINFO` said, which
			# is a property of the machine running the build.
			f"--with-default-terminfo-dir={prefix / 'share' / 'terminfo'}",
			# ...and that path is inside a build directory that will not exist
			# on the host, so the *fallback* search list baked into the binary
			# is the three conventional ones. DevHub sets `TERMINFO` to the
			# unpacked `terminfo/` and that wins over both; this is only what a
			# person running the binary by hand gets.
			"--with-terminfo-dirs=/usr/share/terminfo:/lib/terminfo:/etc/terminfo",
			"--without-debug",
			"--without-ada",
			"--without-cxx-binding",
			"--without-manpages",
			"--without-tests",
		],
		tree,
		env,
	)
	run(["make", f"-j{os.cpu_count() or 2}"], tree, env)
	run(["make", "install"], tree, env)


def build_libevent(tree: Path, prefix: Path, env: dict[str, str]) -> None:
	"""Build libevent's core, without OpenSSL and without the shared library.

	tmux uses the event loop and nothing else. `--disable-openssl` keeps a
	second pinned dependency out of the picture entirely rather than linking
	one in that no code path reaches.
	"""
	run(
		[
			"./configure",
			f"--prefix={prefix}",
			"--disable-shared",
			"--enable-static",
			"--disable-openssl",
			"--disable-samples",
			"--disable-libevent-regress",
		],
		tree,
		env,
	)
	run(["make", f"-j{os.cpu_count() or 2}"], tree, env)
	run(["make", "install"], tree, env)


def build_tmux(tree: Path, prefix: Path, env: dict[str, str], static: bool) -> Path:
	"""Build tmux itself and return the binary, unstripped of nothing but symbols.

	`--enable-static` is tmux's own flag for `-static`, and it is passed only
	where a static libc exists. On macOS it is absent and the result is a
	dynamic binary — the app's, never a release; see `verify`.
	"""
	# `--disable-jemalloc` is not optional in the sense of being a preference:
	# tmux's configure refuses to continue without one of the two, and a
	# jemalloc would be a fourth thing to pin, check and link in for an
	# allocator this build has no reason to want. `--disable-utf8proc` for the
	# same reason — tmux's built-in width tables are what a terminal
	# multiplexer on a server needs, and the alternative is another library.
	configure = [
		"./configure",
		f"--prefix={prefix}",
		"--disable-utf8proc",
		"--disable-jemalloc",
	]
	if static:
		configure.append("--enable-static")
	run(configure, tree, env)
	run(["make", f"-j{os.cpu_count() or 2}"], tree, env)
	binary = tree / "tmux"
	if not binary.is_file():
		raise SystemExit(f"tmux's make produced no {binary}")
	return binary


def compile_terminfo(ncurses_prefix: Path, into: Path, env: dict[str, str]) -> None:
	"""Write the entries the tarball ships, flattened, into a fresh database.

	`infocmp` prints an entry with every `use=` already resolved, so each file
	written here is complete on its own and the directory has no ordering to
	get wrong. `tic` then compiles them with the same ncurses that is linked
	into the binary that will read them.

	`TERMINFO_DIRS` is cleared for both: the point is a database built from the
	pinned source, and a build machine's own `/usr/share/terminfo` shadowing
	one entry of it would be invisible here and wrong on the host.
	"""
	source_db = ncurses_prefix / "share" / "terminfo"
	if not source_db.is_dir():
		raise SystemExit(
			f"ncurses installed no database at {source_db}. It skips that step when "
			"its default terminfo directory is somewhere it was not asked to write "
			"— see the configure flags in build_ncurses."
		)
	infocmp = ncurses_prefix / "bin" / "infocmp"
	tic = ncurses_prefix / "bin" / "tic"
	into.mkdir(parents=True, exist_ok=True)

	tool_env = dict(env)
	tool_env["TERMINFO_DIRS"] = str(source_db)
	tool_env["TERMINFO"] = str(source_db)

	for term in TERMINFO_ENTRIES:
		described = subprocess.run(
			[str(infocmp), "-A", str(source_db), "-x", term],
			capture_output=True,
			text=True,
			env=tool_env,
		)
		if described.returncode != 0:
			raise SystemExit(
				f"ncurses {NCURSES.version} has no terminfo entry for {term!r}:\n"
				f"{described.stderr}"
				"Either the name was mistyped in TERMINFO_ENTRIES or upstream "
				"dropped it. Shipping without it loses colour and keys in a pane "
				"that asks for it, and says nothing."
			)
		compiled = subprocess.run(
			[str(tic), "-x", "-o", str(into), "-"],
			input=described.stdout,
			capture_output=True,
			text=True,
			env=tool_env,
		)
		if compiled.returncode != 0:
			raise SystemExit(f"tic refused the entry for {term!r}:\n{compiled.stderr}")

	written = sorted(p.name for p in into.rglob("*") if p.is_file())
	print(f"  terminfo: {len(written)} entries ({', '.join(written)})")


def stage(binary: Path, terminfo: Path, licenses: dict[str, Path], into: Path) -> None:
	"""Lay out what the host will see, and set the one mode that matters.

	0755 on `bin/tmux`: Python's tarfile carries the mode of the file it read,
	and a tmux that arrives without its executable bit is an install that fails
	on the machine rather than here.
	"""
	if into.exists():
		shutil.rmtree(into)
	(into / "bin").mkdir(parents=True)
	shutil.copy2(binary, into / "bin" / "tmux")
	(into / "bin" / "tmux").chmod(0o755)

	shutil.copytree(terminfo, into / "terminfo")

	(into / "licenses").mkdir()
	for name, path in licenses.items():
		shutil.copy2(path, into / "licenses" / f"{name}.txt")


def check_static(binary: Path, os_name: str) -> None:
	"""Refuse a Linux binary `file` does not call statically linked.

	Shared with `build_bash.py`: the failure it catches — a build that linked
	against the machine it was built on — is the same for every tool DevHub
	puts on a host, and shows up the same way, weeks later, on someone else's.
	"""
	described = subprocess.run(
		["file", str(binary)], capture_output=True, text=True, check=True
	).stdout
	print(f"  {described.strip()}")

	if os_name == "linux":
		if "statically linked" not in described:
			raise SystemExit(
				f"{binary} is not statically linked:\n  {described.strip()}\n"
				"It would need this machine's libc on every host it is installed "
				"on, which is the one thing this build exists to avoid."
			)
	else:
		check_system_only(binary)
		print(
			f"  NOT PUBLISHABLE: a {os_name} build links dynamically against the "
			"system libraries. It is for the app bundle (fetch-tmux.mjs) and must "
			"not be uploaded to a release, which is for hosts."
		)


def check_system_only(binary: Path) -> None:
	"""Refuse a macOS binary that loads a library from outside the OS.

	libevent and ncurses are linked in; a Homebrew `libevent` found by a
	configure would make a tmux that works on the Mac that built it and on no
	other.
	"""
	listed = subprocess.run(
		["otool", "-L", str(binary)], capture_output=True, text=True, check=True
	).stdout.splitlines()[1:]
	foreign = [
		line.strip()
		for line in listed
		if line.strip() and not line.strip().startswith(("/usr/lib/", "/System/"))
	]
	if foreign:
		raise SystemExit(
			f"{binary} loads libraries from outside macOS:\n  "
			+ "\n  ".join(foreign)
			+ "\nIt would run only on the Mac that built it."
		)


def verify(staged: Path, os_name: str, version: str) -> None:
	"""Ask the binary two questions before it goes anywhere.

	What is being caught is a build that linked against the machine it was
	built on — the failure that only appears on someone else's host, weeks
	later, as "not found" from a shell that will not say what was not found.
	`file` names the linkage and `tmux -V` proves the thing runs and is the
	version that was pinned.

	On macOS the linkage assertion is inverted into a refusal to publish: the
	binary *is* dynamic, that is not fixable, and the only correct outcome is
	that nobody mistakes the tarball for a release artefact.
	"""
	binary = staged / "bin" / "tmux"
	check_static(binary, os_name)

	reported = subprocess.run(
		[str(binary), "-V"], capture_output=True, text=True, check=True
	).stdout.strip()
	if reported != f"tmux {version}":
		raise SystemExit(f"expected `tmux {version}` from -V, got {reported!r}")
	print(f"  {reported}")


def pack(staged: Path, tarball: Path, top_level: str) -> None:
	"""Gzip the staged tree under a single top-level directory."""
	tarball.parent.mkdir(parents=True, exist_ok=True)
	if tarball.exists():
		tarball.unlink()
	with tarfile.open(tarball, "w:gz") as archive:
		archive.add(staged, arcname=top_level)


def check_layout(tarball: Path) -> str:
	"""Read the finished tarball back and check what the install will find.

	The install unpacks with `tar --strip-components 1`, runs
	`<dir>/bin/tmux` and sets `TERMINFO` to `<dir>/terminfo`. Every one of
	those is a name, and a name is exactly the kind of thing that is easy to
	change here and impossible to notice until a host reports that a file it
	will not identify is missing. So the tarball is opened after it is written,
	and this is the same function `build_tmux_test.py` runs against a synthetic
	one.

	Returns the top-level directory's name.
	"""
	root = check_tool_layout(tarball, "tmux", (source.name for source in SOURCES))
	with tarfile.open(tarball) as archive:
		names = archive.getnames()
	if not any(name.startswith(f"{root}/terminfo/") for name in names):
		raise SystemExit(
			f"{tarball.name} carries no terminfo database; a static ncurses on a "
			"bare host has nothing to read."
		)
	return root


def check_tool_layout(tarball: Path, tool: str, licenses: Iterable[str]) -> str:
	"""What every tool's tarball must be, whatever else it carries.

	One top-level directory, `bin/<tool>` in it and executable, and a
	`licenses/<name>.txt` for each upstream whose code is in the binary. Shared
	with `build_bash.py`; returns the top-level directory's name.
	"""
	with tarfile.open(tarball) as archive:
		members = archive.getmembers()

	roots = {member.name.split("/", 1)[0] for member in members}
	if len(roots) != 1:
		raise SystemExit(
			f"{tarball.name} has {len(roots)} top-level entries ({sorted(roots)}); "
			"the install moves exactly one directory into place."
		)
	root = roots.pop()

	by_name = {member.name: member for member in members}
	binary = by_name.get(f"{root}/bin/{tool}")
	if binary is None or not binary.isfile():
		raise SystemExit(f"{tarball.name} has no {root}/bin/{tool}")
	if binary.mode & 0o111 != 0o111:
		raise SystemExit(f"{root}/bin/{tool} is mode {binary.mode:o}, not executable")

	for name in licenses:
		expected = f"{root}/licenses/{name}.txt"
		if expected not in by_name:
			raise SystemExit(f"{tarball.name} is missing {expected}")

	return root


def build(target: str, out_dir: Path, work: Path) -> Path:
	"""Build one target end to end and return the tarball."""
	os_name, _, arch = target.partition("-")
	if target != host_target():
		raise SystemExit(
			f"cannot build {target} on {host_target()}: there is no cross-build here, "
			"and a tmux for another architecture is not something this machine can "
			"run `-V` against. Build it on a runner of that architecture."
		)

	prefix = work / "prefix"
	trees = work / "src"
	staged = work / top_level_dir(os_name, arch)
	env = build_env(os_name, prefix)

	unpacked = {}
	for source in SOURCES:
		archive = fetch(source, work / "downloads")
		unpacked[source.name] = unpack(archive, trees)

	print(f"ncurses {NCURSES.version}")
	build_ncurses(unpacked["ncurses"], prefix, env)
	print(f"libevent {LIBEVENT.version}")
	build_libevent(unpacked["libevent"], prefix, env)
	print(f"tmux {TMUX.version}")
	binary = build_tmux(unpacked["tmux"], prefix, env, static=os_name == "linux")

	compile_terminfo(prefix, work / "terminfo", env)
	stage(
		binary,
		work / "terminfo",
		{source.name: unpacked[source.name] / source.license_file for source in SOURCES},
		staged,
	)
	verify(staged, os_name, TMUX.version)

	tarball = out_dir / tarball_name(os_name, arch, TMUX.version)
	pack(staged, tarball, top_level_dir(os_name, arch))
	check_layout(tarball)
	print(f"{tarball.name}: {tarball.stat().st_size / 1e6:.1f} MB")
	return tarball


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument("targets", nargs="*", choices=TARGETS)
	parser.add_argument(
		"--print-version",
		action="store_true",
		help="print the pinned tmux version and exit — how CI names the release "
		"without keeping a second copy of the number",
	)
	parser.add_argument("--out-dir", type=Path, default=REPO_ROOT / "dist")
	parser.add_argument(
		"--work-dir",
		type=Path,
		default=REPO_ROOT / "tmux-build",
		help="where the sources are unpacked and built (gitignored; kept, so a "
		"second run reuses the downloads)",
	)
	args = parser.parse_args()

	if args.print_version:
		print(TMUX.version)
		return 0
	if not args.targets:
		parser.error("name at least one target, or pass --print-version")

	print(f"tmux {TMUX.version}, release {release_tag(TMUX.version)}")
	for target in args.targets:
		build(target, args.out_dir, args.work_dir / target)
	return 0


if __name__ == "__main__":
	sys.exit(main())
