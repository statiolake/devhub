#!/usr/bin/env python3
"""What the app fetches for a host with no bash has to be what CI published,
and what it unpacks has to be what the app then runs.

The same checks `build_tmux_test.py` makes for tmux, for the same reason —
nothing at runtime makes them — plus the command lines of a build that this
suite cannot run (it downloads from ftp.gnu.org and takes a musl toolchain):
the flags that make the binary static and keep the build machine's libraries
out of it are each one line that is easy to lose.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import io
import json
import re
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path

from build_bash import (
	BASH,
	PATCHES,
	SOURCES,
	VERSION,
	bash_env,
	check_layout,
	configure_command,
	patch_command,
	release_tag,
	reports_version,
	tarball_name,
	top_level_dir,
)
from build_tmux import PUBLISHED_TARGETS, pack
from product_metadata import PRODUCT_OVERRIDES

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = PRODUCT_OVERRIDES["bashDownloadUrlTemplate"]
PLACEHOLDERS = ("bashVersion", "os", "arch")


def resolve(template: str, **values: str) -> str:
	for name, value in values.items():
		template = template.replace("${" + name + "}", value)
	return template


class DownloadTemplate(unittest.TestCase):
	def test_resolves_to_the_file_the_build_produces(self) -> None:
		for target in PUBLISHED_TARGETS:
			os_name, _, arch = target.partition("-")
			with self.subTest(target=target):
				self.assertEqual(
					resolve(TEMPLATE, os=os_name, arch=arch, bashVersion=VERSION),
					"https://github.com/statiolake/devhub/releases/download/"
					f"{release_tag(VERSION)}/{tarball_name(os_name, arch, VERSION)}",
				)

	def test_names_only_placeholders_the_app_substitutes(self) -> None:
		self.assertEqual(set(re.findall(r"\$\{(\w+)\}", TEMPLATE)), set(PLACEHOLDERS))

	def test_does_not_reuse_a_name_another_template_means(self) -> None:
		# `${version}` is VS Code's in `serverDownloadUrlTemplate`, and
		# `${tmuxVersion}` is tmux's: the app substitutes `${bashVersion}`.
		for name in ("${version}", "${commit}", "${tmuxVersion}"):
			with self.subTest(name=name):
				self.assertNotIn(name, TEMPLATE)

	def test_the_app_asks_for_the_version_this_builds(self) -> None:
		# The app installs into `bash/<bashVersion>` and resolves the URL with
		# it; a pin moved here and not there is a 404 on every bare host.
		self.assertEqual(PRODUCT_OVERRIDES["bashVersion"], VERSION)

	def test_the_template_is_stated_in_the_file_the_app_reads(self) -> None:
		path = REPO_ROOT / "apps" / "desktop" / "product-overrides.json"
		self.assertEqual(json.loads(path.read_text())["bashDownloadUrlTemplate"], TEMPLATE)


class Pins(unittest.TestCase):
	def test_every_download_states_a_sha256_and_is_https(self) -> None:
		for pinned in (*SOURCES, *PATCHES):
			with self.subTest(archive=pinned.archive):
				self.assertRegex(pinned.sha256, r"^[0-9a-f]{64}$")
				self.assertTrue(pinned.url.startswith("https://"), pinned.url)
				self.assertTrue(pinned.url.endswith("/" + pinned.archive), pinned.url)

	def test_no_two_downloads_share_a_digest(self) -> None:
		digests = [pinned.sha256 for pinned in (*SOURCES, *PATCHES)]
		self.assertEqual(len(set(digests)), len(digests))

	def test_the_release_is_a_bash_release(self) -> None:
		self.assertEqual(BASH.unpacked, f"bash-{BASH.version}")
		self.assertIn(BASH.version, BASH.url)
		self.assertRegex(BASH.version, r"^\d+\.\d+$")

	def test_the_patches_are_every_level_in_order(self) -> None:
		# Each patch assumes the ones before it, and the count is the patch
		# level `bash --version` reports.
		self.assertEqual([patch.level for patch in PATCHES], list(range(1, len(PATCHES) + 1)))
		self.assertEqual(PATCHES[0].archive, "bash53-001")
		self.assertEqual(
			PATCHES[0].url, "https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-001"
		)

	def test_the_published_version_is_the_release_and_its_patch_level(self) -> None:
		self.assertEqual(VERSION, f"{BASH.version}.{len(PATCHES)}")


class Names(unittest.TestCase):
	def test_release_tag_is_keyed_on_the_bash_version(self) -> None:
		# Its own release, beside tmux's and never inside it: a bash patch does
		# not republish a tmux, and the other way round.
		self.assertEqual(release_tag("5.3.20"), "bash-5.3.20")

	def test_names_follow_the_tmux_convention(self) -> None:
		self.assertEqual(
			tarball_name("linux", "x64", "5.3.20"), "devhub-bash-linux-x64-5.3.20.tar.gz"
		)
		self.assertEqual(top_level_dir("linux", "arm64"), "devhub-bash-linux-arm64")


class Commands(unittest.TestCase):
	"""The build this suite cannot run, by the command lines it would run."""

	def test_a_linux_build_is_static_without_bash_malloc_or_nls(self) -> None:
		command = configure_command(Path("/p"), static=True)
		self.assertEqual(command[0], "./configure")
		self.assertIn("--prefix=/p", command)
		self.assertIn("--enable-static-link", command)
		# bash's own allocator is the part that does not build against musl.
		self.assertIn("--without-bash-malloc", command)
		self.assertIn("--disable-nls", command)

	def test_the_darwin_self_test_is_not_static(self) -> None:
		self.assertNotIn("--enable-static-link", configure_command(Path("/p"), static=False))

	def test_the_machine_libraries_are_not_build_inputs(self) -> None:
		env = bash_env("darwin", Path("/p"))  # `cc`: no musl-gcc needed to ask
		self.assertEqual(env["bash_cv_termcap_lib"], "gnutermcap")
		self.assertEqual(env["PKG_CONFIG_LIBDIR"], "/p/lib/pkgconfig")
		for leaked in ("TERM", "TERMINFO", "TERMINFO_DIRS"):
			self.assertNotIn(leaked, env)

	def test_patches_apply_from_the_tree_root_once(self) -> None:
		self.assertEqual(
			patch_command(Path("/d/bash53-001")),
			["patch", "-p0", "--forward", "--batch", "-i", "/d/bash53-001"],
		)

	def test_reads_the_patch_level_from_bash_version(self) -> None:
		line = "GNU bash, version 5.3.20(1)-release (x86_64-pc-linux-musl)"
		self.assertTrue(reports_version(line, "5.3.20"))
		self.assertFalse(reports_version(line, "5.3.2"))
		self.assertFalse(reports_version("GNU bash, version 5.2.21(1)-release", "5.3.20"))


class TarballLayout(unittest.TestCase):
	def setUp(self) -> None:
		self.work = Path(tempfile.mkdtemp(prefix="bash-test-"))
		self.addCleanup(lambda: shutil.rmtree(self.work, ignore_errors=True))
		self.staged = self.work / "staged"

	def write(self, relative: str, mode: int = 0o644) -> None:
		path = self.staged / relative
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_bytes(b"\0" * 16)
		path.chmod(mode)

	def complete(self) -> None:
		self.write("bin/bash", 0o755)
		self.write("licenses/bash.txt")

	def packed(self) -> Path:
		tarball = self.work / tarball_name("linux", "x64", VERSION)
		pack(self.staged, tarball, top_level_dir("linux", "x64"))
		return tarball

	def test_accepts_what_the_build_stages(self) -> None:
		self.complete()
		self.assertEqual(check_layout(self.packed()), "devhub-bash-linux-x64")

	def test_refuses_a_bash_that_is_not_executable(self) -> None:
		self.complete()
		(self.staged / "bin" / "bash").chmod(0o644)
		with self.assertRaises(SystemExit):
			check_layout(self.packed())

	def test_refuses_a_tarball_with_no_bash(self) -> None:
		self.complete()
		(self.staged / "bin" / "bash").unlink()
		with self.assertRaises(SystemExit):
			check_layout(self.packed())

	def test_refuses_to_redistribute_without_the_licence(self) -> None:
		# GPL-3.0: the licence travels with the binary.
		self.complete()
		(self.staged / "licenses" / "bash.txt").unlink()
		with self.assertRaises(SystemExit):
			check_layout(self.packed())

	def test_refuses_two_top_level_directories(self) -> None:
		self.complete()
		tarball = self.work / "two-roots.tar.gz"
		with tarfile.open(tarball, "w:gz") as archive:
			archive.add(self.staged, arcname="devhub-bash-linux-x64")
			archive.addfile(tarfile.TarInfo("stray/README"), io.BytesIO(b""))
		with self.assertRaises(SystemExit):
			check_layout(tarball)


class Workflow(unittest.TestCase):
	def setUp(self) -> None:
		self.workflow = (REPO_ROOT / ".github" / "workflows" / "nightly.yml").read_text()

	def test_builds_every_published_target(self) -> None:
		self.assertIn("scripts/build_bash.py ${{ matrix.target }}", self.workflow)
		bash_jobs = self.workflow[self.workflow.index("  bash:\n") :]
		for target in PUBLISHED_TARGETS:
			with self.subTest(target=target):
				self.assertIn(f"target: {target}", bash_jobs)

	def test_names_the_release_by_asking_the_script(self) -> None:
		self.assertIn("scripts/build_bash.py --print-version", self.workflow)
		self.assertIn('tag="bash-${version}"', self.workflow)

	def test_never_publishes_the_darwin_self_test(self) -> None:
		self.assertNotIn("build_bash.py darwin", self.workflow)


if __name__ == "__main__":
	unittest.main()
