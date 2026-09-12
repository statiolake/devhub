#!/usr/bin/env python3
"""The vendored trees in git are the trees the edit table describes.

`extensions/vendor/` is committed patched, and nothing at build time re-applies
the edits — `stage-builtin-extensions.sh` symlinks the directories and
`package-nightly.py` copies them, both verbatim. So the only thing standing
between a re-vendored extension and shipping the bug again is this test: unpack
a new VSIX over the directory, forget to run `--apply`, and it says so.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import unittest

from patch_vendored_extensions import (
	EDITS,
	VENDOR_DIR,
	Patch,
	PatchError,
	Replace,
	check_edits,
)


class TheCommittedTree(unittest.TestCase):
	def test_carries_every_edit(self) -> None:
		self.assertEqual(check_edits(), [])

	def test_names_only_extensions_that_are_there(self) -> None:
		for extension in EDITS:
			self.assertTrue(
				(VENDOR_DIR / extension / "package.json").is_file(),
				f"{extension} is in the edit table but not in extensions/vendor/",
			)

	def test_every_patch_file_exists(self) -> None:
		for extension, edits in EDITS.items():
			for edit in edits:
				if isinstance(edit, Patch):
					self.assertTrue(edit.patch_file(extension).is_file())


class TheEditsThemselves(unittest.TestCase):
	"""What the port is *for*, asserted on the artefacts rather than on prose."""

	def setUp(self) -> None:
		self.script = (
			VENDOR_DIR / "open-remote-ssh" / "src" / "scripts" / "server-setup.sh"
		).read_text(encoding="utf8")
		self.bundle = (
			VENDOR_DIR / "open-remote-ssh" / "lib" / "extension.js"
		).read_text(encoding="utf8")

	def test_the_install_script_is_piped_into_sh(self) -> None:
		self.assertIn("| base64 -d | sh -l`)", self.bundle)
		self.assertNotIn("bash -l", self.bundle)

	def test_the_install_script_has_no_bashisms(self) -> None:
		# The five that broke it on a BusyBox host, each one a construct the
		# POSIX shell command language does not define.
		for bashism in ("[[", "]]", "pushd", "popd", "&> ", "{1.."):
			self.assertNotIn(
				bashism,
				self.script,
				f"server-setup.sh still uses the bash construct {bashism!r}",
			)

	def test_the_result_markers_are_untouched(self) -> None:
		# What `parseServerInstallOutput` greps for. A port that renamed one of
		# these would resolve nothing and say "Failed parsing install script
		# output" — the very message this whole change exists to explain.
		for marker in (
			'echo "%%SCRIPT_ID%%: start"',
			'echo "exitCode==$1=="',
			'echo "listeningOn==$LISTENING_ON=="',
			'echo "connectionToken==$SERVER_CONNECTION_TOKEN=="',
			'echo "logFile==$SERVER_LOGFILE=="',
			'echo "osReleaseId==$OS_RELEASE_ID=="',
			'echo "arch==$ARCH=="',
			'echo "platform==$PLATFORM=="',
			'echo "tmpDir==$TMP_DIR=="',
			"%%ENV_VAR_LINES%%",
			'echo "%%SCRIPT_ID%%: end"',
		):
			self.assertIn(marker, self.script)

	def test_every_template_placeholder_survived(self) -> None:
		# `compileTemplate` substitutes these by name; one dropped in the port
		# would be shipped to the remote as a literal `%%…%%`.
		for placeholder in (
			"%%DISTRO_VERSION%%",
			"%%DISTRO_COMMIT%%",
			"%%DISTRO_QUALITY%%",
			"%%DISTRO_VSCODIUM_RELEASE%%",
			"%%SERVER_APP_NAME%%",
			"%%SERVER_INITIAL_EXTENSIONS%%",
			"%%SERVER_LISTEN_FLAG%%",
			"%%SERVER_DATA_DIR%%",
			"%%SERVER_DATA_DIR_FLAG%%",
			"%%SERVER_VALIDATION_FLAG%%",
			"%%SERVER_DOWNLOAD_URL_TEMPLATE%%",
			"%%SERVER_CONNECTION_TOKEN%%",
			"%%MODIFY_PRODUCT_JSON%%",
			"%%SCRIPT_ID%%",
			"%%ENV_VAR_LINES%%",
		):
			self.assertIn(placeholder, self.script)

	def test_a_failed_resolve_carries_the_remote_s_own_words(self) -> None:
		self.assertIn("devhubReason", self.bundle)
		self.assertIn("{modal:!0,detail:devhubReason}", self.bundle)


class ARewrittenEdit(unittest.TestCase):
	"""`Replace` refuses rather than guessing, and applying twice is applying once."""

	def test_says_so_when_the_anchor_is_not_there(self) -> None:
		import tempfile

		with tempfile.TemporaryDirectory() as tmp:
			from pathlib import Path

			import patch_vendored_extensions as module

			original = module.VENDOR_DIR
			module.VENDOR_DIR = Path(tmp)
			try:
				(Path(tmp) / "ext").mkdir()
				target = Path(tmp) / "ext" / "f.txt"
				edit = Replace(path="f.txt", before="alpha", after="beta", why="test")

				target.write_text("nothing to see", encoding="utf8")
				with self.assertRaises(PatchError):
					edit.apply("ext")

				target.write_text("an alpha here", encoding="utf8")
				edit.apply("ext")
				self.assertEqual(target.read_text(encoding="utf8"), "an beta here")
				edit.apply("ext")
				self.assertEqual(target.read_text(encoding="utf8"), "an beta here")
				edit.check("ext")

				target.write_text("an alpha and an alpha", encoding="utf8")
				with self.assertRaises(PatchError):
					edit.apply("ext")
			finally:
				module.VENDOR_DIR = original


if __name__ == "__main__":
	unittest.main()
