#!/usr/bin/env python3
"""The tmux build's names and its tarball's layout, checked against what the
app's install expects.

Nothing at runtime checks them. The app unpacks the tarball DevHub's tools
release carries (`scripts/build_tools.py`) into `out/tmux`, and sends it as it
is to an SSH host's `~/.devhub-server/tmux/<version>/`. A name or a layout
that changes here shows up as a host on which terminals and Agents do not
start.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import io
import tarfile
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from build_tmux import (
	LIBEVENT,
	NCURSES,
	SOURCES,
	TARGETS,
	TERMINFO_ENTRIES,
	TMUX,
	check_layout,
	check_system_only,
	download,
	pack,
	tarball_name,
	top_level_dir,
)
class Download(unittest.TestCase):
	"""A server that could not answer now is asked again; any other answer is final."""

	def answers(self, *outcomes):
		calls = []

		def opener(url):
			calls.append(url)
			outcome = outcomes[len(calls) - 1]
			if isinstance(outcome, Exception):
				raise outcome
			return io.BytesIO(outcome)

		return opener, calls

	def gateway(self, code: int = 504) -> urllib.error.HTTPError:
		return urllib.error.HTTPError("https://x/a", code, "Gateway Time-out", {}, None)

	def test_a_5xx_or_an_unreachable_server_is_asked_again(self) -> None:
		opener, calls = self.answers(
			self.gateway(), urllib.error.URLError("reset"), b"bytes"
		)
		waits = []
		with mock.patch("builtins.print"):
			self.assertEqual(download("https://x/a", wait=waits.append, opener=opener), b"bytes")
		self.assertEqual(len(calls), 3)
		self.assertEqual(waits, [2, 4])

	def test_a_4xx_is_final(self) -> None:
		opener, calls = self.answers(self.gateway(404))
		with self.assertRaises(urllib.error.HTTPError):
			download("https://x/a", wait=lambda _: None, opener=opener)
		self.assertEqual(len(calls), 1)

	def test_it_gives_up_after_six(self) -> None:
		opener, calls = self.answers(*[self.gateway()] * 6)
		with mock.patch("builtins.print"), self.assertRaises(urllib.error.HTTPError):
			download("https://x/a", wait=lambda _: None, opener=opener)
		self.assertEqual(len(calls), 6)


class Pins(unittest.TestCase):
	"""Every source is fetched over the network and linked into a binary DevHub
	installs on other people's machines. A pin without a checksum is a promise
	the publisher never made."""

	def test_every_source_states_a_sha256(self) -> None:
		for source in SOURCES:
			with self.subTest(source=source.name):
				self.assertRegex(source.sha256, r"^[0-9a-f]{64}$")

	def test_every_source_is_fetched_over_https(self) -> None:
		for source in SOURCES:
			with self.subTest(source=source.name):
				self.assertTrue(source.url.startswith("https://"), source.url)

	def test_every_url_names_the_version_that_is_pinned(self) -> None:
		# A pin that says 3.7c beside a URL that fetches 3.6 is a build nobody
		# reads twice, and the tarball would be named after the version that
		# was not built.
		for source in SOURCES:
			with self.subTest(source=source.name):
				self.assertIn(source.version, source.url)
				self.assertEqual(source.unpacked, f"{source.name}-{source.version}")

	def test_the_release_is_a_stable_tmux(self) -> None:
		# 3.8-rc exists upstream and is marked prerelease; a candidate is not
		# something to install on someone's NAS.
		self.assertRegex(TMUX.version, r"^3\.\d+[a-z]?$")

	def test_the_dependencies_are_the_two_tmux_needs(self) -> None:
		self.assertEqual({s.name for s in SOURCES}, {"tmux", "libevent", "ncurses"})
		self.assertIs(SOURCES[0], NCURSES)  # built first: libevent and tmux link it
		self.assertIs(SOURCES[1], LIBEVENT)


class Names(unittest.TestCase):
	def test_every_target_has_its_own_tarball(self) -> None:
		names = {tarball_name(*t.partition("-")[::2], TMUX.version) for t in TARGETS}
		self.assertEqual(len(names), len(TARGETS))

	def test_top_level_directory_is_not_the_tarball_name(self) -> None:
		# `tar --strip-components 1` takes whatever the one directory is called;
		# what it must not be is the archive's own name with `.tar.gz` on it.
		self.assertEqual(top_level_dir("linux", "x64"), "devhub-tmux-linux-x64")
		self.assertNotIn(".tar.gz", top_level_dir("linux", "x64"))


class TerminfoEntries(unittest.TestCase):
	def test_ships_what_tmux_sets_inside_its_own_panes(self) -> None:
		# tmux's `default-terminal` is one of these, and a pane whose TERM has
		# no entry loses colour and cursor keys without reporting anything.
		self.assertIn("tmux-256color", TERMINFO_ENTRIES)
		self.assertIn("screen-256color", TERMINFO_ENTRIES)

	def test_ships_what_a_client_attaches_with(self) -> None:
		self.assertIn("xterm-256color", TERMINFO_ENTRIES)

	def test_names_no_entry_twice(self) -> None:
		self.assertEqual(len(set(TERMINFO_ENTRIES)), len(TERMINFO_ENTRIES))


class TarballLayout(unittest.TestCase):
	"""`check_layout` is what the build runs against the file it just wrote, so
	the cases it must refuse are worth having without a two-hour build.

	What it stands in for: the install unpacks with `tar --strip-components 1`,
	runs `<dir>/bin/tmux` and points `TERMINFO` at `<dir>/terminfo`. Each of
	those is a name that is easy to change here and impossible to notice until
	a host says a file is missing.
	"""

	def setUp(self) -> None:
		self.work = Path(tempfile.mkdtemp(prefix="tmux-test-"))
		self.addCleanup(lambda: __import__("shutil").rmtree(self.work, ignore_errors=True))
		self.staged = self.work / "staged"

	def write(self, relative: str, mode: int = 0o644) -> Path:
		path = self.staged / relative
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_bytes(b"\0" * 16)
		path.chmod(mode)
		return path

	def complete(self) -> None:
		self.write("bin/tmux", 0o755)
		self.write("terminfo/x/xterm-256color")
		for source in SOURCES:
			self.write(f"licenses/{source.name}.txt")

	def packed(self) -> Path:
		tarball = self.work / tarball_name("linux", "x64", TMUX.version)
		pack(self.staged, tarball, top_level_dir("linux", "x64"))
		return tarball

	def test_accepts_what_the_build_stages(self) -> None:
		self.complete()
		self.assertEqual(check_layout(self.packed()), "devhub-tmux-linux-x64")

	def test_refuses_a_tmux_that_is_not_executable(self) -> None:
		self.complete()
		(self.staged / "bin" / "tmux").chmod(0o644)
		with self.assertRaises(SystemExit):
			check_layout(self.packed())

	def test_refuses_a_tarball_with_no_tmux_in_it(self) -> None:
		self.complete()
		(self.staged / "bin" / "tmux").unlink()
		with self.assertRaises(SystemExit):
			check_layout(self.packed())

	def test_refuses_a_tarball_with_no_terminfo(self) -> None:
		# A static ncurses has the code and no database; a bare host may have
		# none of its own, which is the case this whole directory is for.
		self.complete()
		__import__("shutil").rmtree(self.staged / "terminfo")
		with self.assertRaises(SystemExit):
			check_layout(self.packed())

	def test_refuses_to_redistribute_without_the_licences(self) -> None:
		for source in SOURCES:
			with self.subTest(missing=source.name):
				self.complete()
				(self.staged / "licenses" / f"{source.name}.txt").unlink()
				with self.assertRaises(SystemExit):
					check_layout(self.packed())

	def test_refuses_two_top_level_directories(self) -> None:
		self.complete()
		tarball = self.work / "two-roots.tar.gz"
		with tarfile.open(tarball, "w:gz") as archive:
			archive.add(self.staged, arcname="devhub-tmux-linux-x64")
			info = tarfile.TarInfo("stray/README")
			archive.addfile(info, io.BytesIO(b""))
		with self.assertRaises(SystemExit):
			check_layout(tarball)


class DarwinLinkage(unittest.TestCase):
	"""The app's macOS tmux may load libSystem and nothing from outside the OS."""

	def otool(self, *libraries: str):
		listing = "tmux:\n" + "".join(f"\t{line} (compatibility version 1.0.0)\n" for line in libraries)
		return mock.patch(
			"build_tmux.subprocess.run",
			return_value=mock.Mock(stdout=listing),
		)

	def test_accepts_the_system_libraries(self) -> None:
		with self.otool("/usr/lib/libSystem.B.dylib", "/usr/lib/libresolv.9.dylib"):
			check_system_only(Path("tmux"))

	def test_refuses_a_homebrew_library(self) -> None:
		with self.otool("/opt/homebrew/opt/libevent/lib/libevent-2.1.7.dylib", "/usr/lib/libSystem.B.dylib"):
			with self.assertRaises(SystemExit) as raised:
				check_system_only(Path("tmux"))
		self.assertIn("libevent", str(raised.exception))


if __name__ == "__main__":
	unittest.main()
