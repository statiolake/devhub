#!/usr/bin/env python3
"""What the packaged app's generated entry point may and may not say.

A packaged DevHub launched with `DEVHUB_PROFILE=x` joined the *default*
instance ("Sending env to running instance... Terminating.") because the entry
spelled `Application Support/DevHub` itself instead of asking the profile
module. These tests pin the fix where it can regress: in the generated source.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def _package_nightly():
	"""The script, imported by path: its file name is not an identifier."""
	spec = importlib.util.spec_from_file_location(
		"package_nightly", SCRIPTS / "package-nightly.py"
	)
	assert spec is not None and spec.loader is not None
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


package_nightly = _package_nightly()


class GeneratedEntry(unittest.TestCase):
	def setUp(self) -> None:
		self.source = package_nightly.ENTRY_SOURCE

	def test_derives_the_directories_from_the_profile_module(self) -> None:
		self.assertIn(
			f'import {{ currentProfile }} from "{package_nightly.PROFILE_MODULE}";',
			self.source,
		)
		self.assertIn("currentProfile(homedir(), process.env)", self.source)
		self.assertIn("profile.userDataDirectory", self.source)
		self.assertIn("profile.extensionsDirectory", self.source)

	def test_spells_no_directory_of_its_own(self) -> None:
		self.assertNotIn("Application Support", self.source)
		self.assertNotIn('"DevHub"', self.source)

	def test_the_profile_module_it_imports_is_one_the_bundle_ships(self) -> None:
		# assemble_app_directory copies apps/desktop/out into Resources/app/out,
		# so the entry's relative import has to resolve inside that copy.
		relative = package_nightly.PROFILE_MODULE.removeprefix("./")
		compiled = package_nightly.DESKTOP_DIR / relative
		source = compiled.with_suffix(".ts").as_posix().replace("/out/", "/src/")
		self.assertTrue(
			Path(source).is_file(), f"{source} is the module the entry depends on"
		)

	def test_explicit_arguments_still_win(self) -> None:
		self.assertIn("process.argv.some", self.source)


if __name__ == "__main__":
	unittest.main()
