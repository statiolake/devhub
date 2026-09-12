#!/usr/bin/env python3
"""What the app fetches has to be what CI published, and what it unpacks has to
be what the app then runs.

Neither of those is checked at runtime. The app substitutes three names into
`tmuxDownloadUrlTemplate`, downloads whatever comes back and unpacks it into
`~/.devhub-server/tmux/<version>/`; `scripts/build_tmux.py` names a file and
`.github/workflows/nightly.yml` uploads it to a release named after the pinned
version. If any of those disagree the symptom is a host on which terminals and
Agents do not start, with a 404 in a log.

So the template, the namer and the tarball layout are checked against each
other here.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import io
import json
import re
import tarfile
import tempfile
import unittest
from pathlib import Path

from build_tmux import (
	LIBEVENT,
	NCURSES,
	PUBLISHED_TARGETS,
	SOURCES,
	TARGETS,
	TERMINFO_ENTRIES,
	TMUX,
	check_layout,
	pack,
	release_tag,
	tarball_name,
	top_level_dir,
)
from product_metadata import PRODUCT_OVERRIDES

TEMPLATE = PRODUCT_OVERRIDES["tmuxDownloadUrlTemplate"]

# The three the app substitutes, and the whole of it. `${version}` is
# deliberately not among them: `product.json` already uses that name for VS
# Code's version in `serverDownloadUrlTemplate`, and two templates in one file
# whose `${version}` means two different things is a mistake waiting for
# whoever writes the third.
PLACEHOLDERS = ("tmuxVersion", "os", "arch")


def resolve(template: str, **values: str) -> str:
	for name, value in values.items():
		template = template.replace("${" + name + "}", value)
	return template


class DownloadTemplate(unittest.TestCase):
	def test_resolves_to_the_file_the_build_produces(self) -> None:
		for target in PUBLISHED_TARGETS:
			os_name, _, arch = target.partition("-")
			with self.subTest(target=target):
				url = resolve(
					TEMPLATE, os=os_name, arch=arch, tmuxVersion=TMUX.version
				)
				self.assertEqual(
					url,
					"https://github.com/statiolake/devhub/releases/download/"
					f"{release_tag(TMUX.version)}/"
					f"{tarball_name(os_name, arch, TMUX.version)}",
				)

	def test_leaves_nothing_to_substitute(self) -> None:
		url = resolve(TEMPLATE, os="linux", arch="x64", tmuxVersion=TMUX.version)
		self.assertNotIn("${", url)

	def test_names_only_placeholders_the_app_substitutes(self) -> None:
		named = set(re.findall(r"\$\{(\w+)\}", TEMPLATE))
		self.assertEqual(named, set(PLACEHOLDERS))

	def test_does_not_reuse_a_name_the_server_template_already_means(self) -> None:
		# `${version}` in `serverDownloadUrlTemplate` is VS Code's version —
		# one of the six names the Open Remote - SSH install script substitutes
		# on the host. This template is substituted by DevHub itself and could
		# use the name for tmux's, and then `product.json` would hold two
		# templates whose `${version}` means two different things.
		self.assertNotIn("${version}", TEMPLATE)
		self.assertNotIn("${commit}", TEMPLATE)


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
	def test_release_tag_is_keyed_on_the_tmux_version(self) -> None:
		# Not on a date and not on DevHub's commit: the tarball is a function of
		# the pinned version, so the release never has to move and an app built
		# months ago goes on finding it.
		self.assertEqual(release_tag("3.7c"), "tmux-3.7c")

	def test_every_target_has_its_own_tarball(self) -> None:
		names = {tarball_name(*t.partition("-")[::2], TMUX.version) for t in TARGETS}
		self.assertEqual(len(names), len(TARGETS))

	def test_darwin_is_not_published(self) -> None:
		# macOS has no static libc, so what this script builds there links
		# against the machine that built it. It stays in TARGETS as a self-test
		# and out of PUBLISHED_TARGETS so nothing uploads it.
		self.assertIn("darwin-arm64", TARGETS)
		self.assertNotIn("darwin-arm64", PUBLISHED_TARGETS)
		self.assertEqual(set(PUBLISHED_TARGETS), {"linux-x64", "linux-arm64"})

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


class Workflow(unittest.TestCase):
	"""The job that publishes it, read as text: there is no other check that CI
	builds the targets the template promises."""

	def setUp(self) -> None:
		self.workflow = (
			Path(__file__).resolve().parent.parent / ".github" / "workflows" / "nightly.yml"
		).read_text()

	def test_builds_every_published_target(self) -> None:
		for target in PUBLISHED_TARGETS:
			with self.subTest(target=target):
				self.assertIn(f"target: {target}", self.workflow)

	def test_never_publishes_the_darwin_self_test(self) -> None:
		self.assertNotIn("build_tmux.py darwin", self.workflow)


class Overrides(unittest.TestCase):
	def test_the_template_is_stated_in_the_file_the_app_reads(self) -> None:
		# `PRODUCT_OVERRIDES` is loaded from this file; asserting on the file
		# keeps the two from being the same typo read twice.
		path = (
			Path(__file__).resolve().parent.parent
			/ "apps"
			/ "desktop"
			/ "product-overrides.json"
		)
		self.assertEqual(json.loads(path.read_text())["tmuxDownloadUrlTemplate"], TEMPLATE)


if __name__ == "__main__":
	unittest.main()
