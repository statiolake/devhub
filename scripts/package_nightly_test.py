#!/usr/bin/env python3
"""What packaging copies of the main process's dependencies.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def _package_nightly():
	"""The script, imported by path: its file name is not an identifier."""
	spec = importlib.util.spec_from_file_location("package_nightly", SCRIPTS / "package-nightly.py")
	assert spec is not None and spec.loader is not None
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


package_nightly = _package_nightly()


class PackageNames(unittest.TestCase):
	def test_a_bare_or_deep_specifier_is_its_package(self) -> None:
		self.assertEqual(package_nightly.package_name("node-pty"), "node-pty")
		self.assertEqual(package_nightly.package_name("minimist/index.js"), "minimist")
		self.assertEqual(package_nightly.package_name("@scope/pkg/sub"), "@scope/pkg")

	def test_relative_builtin_and_electron_are_not_dependencies(self) -> None:
		for specifier in ("./x.js", "../y.js", "node:fs", "electron", "original-fs"):
			self.assertIsNone(package_nightly.package_name(specifier), specifier)


class PrebuildFilter(unittest.TestCase):
	def test_keeps_only_this_platforms_prebuild(self) -> None:
		ignore = package_nightly.ignore_other_platforms("darwin-arm64")
		dropped = ignore("/x/node_modules/node-pty/prebuilds", ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"])
		self.assertEqual(dropped, {"darwin-x64", "linux-x64", "win32-x64"})

	def test_drops_node_ptys_sources(self) -> None:
		ignore = package_nightly.ignore_other_platforms("linux-x64")
		dropped = ignore("/x/node_modules/node-pty", ["lib", "prebuilds", "src", "binding.gyp", "package.json"])
		self.assertEqual(dropped, {"src", "binding.gyp"})


class NightlyPlist(unittest.TestCase):
	"""What only the packaged bundle's Info.plist says."""

	def test_names_the_build_and_claims_devhub_links(self) -> None:
		extra = package_nightly.nightly_plist("0.1.0", "20261113", "0123456789abcdef")
		self.assertEqual(extra["CFBundleVersion"], "0.1.0.20261113+0123456789")
		schemes = [scheme for entry in extra["CFBundleURLTypes"] for scheme in entry["CFBundleURLSchemes"]]
		self.assertEqual(schemes, ["devhub"])


class FreshBuild(unittest.TestCase):
	"""Packaging copies `out/` and `dist/` whole and scans every `.js` in `out/`,
	so a file the current sources no longer emit must not survive a build."""

	def test_the_build_starts_by_deleting_what_packaging_copies(self) -> None:
		manifest = json.loads((package_nightly.DESKTOP_DIR / "package.json").read_text())
		scripts = manifest["scripts"]
		self.assertTrue(scripts["build"].startswith("pnpm run clean && "), scripts["build"])
		self.assertEqual(scripts["clean"].split()[:2], ["rm", "-rf"])
		self.assertLessEqual({"out", "dist"}, set(scripts["clean"].split()[2:]))


if __name__ == "__main__":
	unittest.main()
