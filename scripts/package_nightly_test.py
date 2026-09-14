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
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


class DownloadedBuiltins(unittest.TestCase):
	"""The half of VS Code's built-in set product.json downloads.

	Without js-debug there is no debug adapter for `node`, `node-terminal` or
	`extensionHost`, and nothing else about the app looks wrong — so packaging a
	set that is missing one has to be an error here rather than a dead F5 later.
	"""

	def setUp(self) -> None:
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		self.vscode = root / "vscode"
		self.vscode.mkdir()
		(self.vscode / "product.json").write_text(
			json.dumps({"builtInExtensions": [{"name": "ms-vscode.js-debug", "version": "1.117.0"}]})
		)
		self.staged = root / "extensions"
		self.staged.mkdir()
		patcher = mock.patch.object(package_nightly, "VSCODE_DIR", self.vscode)
		patcher.start()
		self.addCleanup(patcher.stop)

	def _stage(self, version: str) -> None:
		extension = self.staged / "ms-vscode.js-debug"
		extension.mkdir()
		(extension / "package.json").write_text(json.dumps({"version": version}))

	def test_a_staged_set_at_the_pinned_version_passes(self) -> None:
		self._stage("1.117.0")
		package_nightly.check_downloaded_builtins(self.staged)

	def test_a_missing_one_is_refused(self) -> None:
		with self.assertRaises(SystemExit):
			package_nightly.check_downloaded_builtins(self.staged)

	def test_a_stale_version_is_refused(self) -> None:
		self._stage("1.100.0")
		with self.assertRaises(SystemExit):
			package_nightly.check_downloaded_builtins(self.staged)

	def test_the_real_product_json_names_a_javascript_debugger(self) -> None:
		# The rule this whole check exists for: DevHub's built-in set is VS
		# Code's, and VS Code's includes the debugger it downloads.
		product = json.loads((package_nightly.REPO_ROOT / "vscode" / "product.json").read_text())
		names = {extension["name"] for extension in product.get("builtInExtensions", [])}
		self.assertIn("ms-vscode.js-debug", names)


if __name__ == "__main__":
	unittest.main()
