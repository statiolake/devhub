#!/usr/bin/env python3
"""What DevHub tells macOS it can open.

`CFBundleDocumentTypes` is the only reason DevHub appears in Finder's "Open
With" for a Markdown file, and it is derived rather than written — from the
list VS Code's own Electron staging step already generated into the bundle
DevHub renames. These tests pin the three things that derivation must not lose:
the extensions themselves, a rank that never steals somebody's default, and one
entry per extension.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import plistlib
import unittest

from darwin_bundle import BASE_APP, ICON_FILE, document_types

# One entry of the shape VS Code's staging step writes, kept small on purpose:
# the tests below are about the derivation, and the real list is exercised by
# `StagedElectron` at the end.
MARKDOWN = {
	"CFBundleTypeName": "Markdown document",
	"CFBundleTypeRole": "Editor",
	"CFBundleTypeOSTypes": ["TEXT", "utxt", "TUTX", "****"],
	"CFBundleTypeExtensions": ["markdown", "md", "mdown"],
	"CFBundleTypeIconFile": "markdown.icns",
}
PYTHON = {
	"CFBundleTypeName": "Python script",
	"CFBundleTypeRole": "Editor",
	"CFBundleTypeOSTypes": ["TEXT", "utxt", "TUTX", "****"],
	"CFBundleTypeExtensions": ["py", "pyi"],
	"CFBundleTypeIconFile": "python.icns",
}


class DocumentTypes(unittest.TestCase):
	def test_keeps_every_extension_it_was_given(self) -> None:
		types = document_types([MARKDOWN, PYTHON])

		self.assertEqual(
			[entry["CFBundleTypeExtensions"] for entry in types],
			[["markdown", "md", "mdown"], ["py", "pyi"]],
		)

	def test_ranks_every_type_alternate(self) -> None:
		"""Installing DevHub must never change what double-clicking a file does."""
		types = document_types([MARKDOWN, PYTHON])

		self.assertEqual({entry["LSHandlerRank"] for entry in types}, {"Alternate"})

	def test_opens_rather_than_views(self) -> None:
		types = document_types([MARKDOWN, PYTHON])

		self.assertEqual({entry["CFBundleTypeRole"] for entry in types}, {"Editor"})

	def test_wears_devhubs_icon_rather_than_another_products(self) -> None:
		types = document_types([MARKDOWN, PYTHON])

		self.assertEqual(
			{entry["CFBundleTypeIconFile"] for entry in types}, {ICON_FILE.name}
		)

	def test_refuses_an_extension_claimed_twice(self) -> None:
		"""Launch Services ignores the second entry, so a duplicate is a silent hole."""
		with self.assertRaises(ValueError) as raised:
			document_types([MARKDOWN, {**PYTHON, "CFBundleTypeExtensions": ["md"]}])

		self.assertIn("'md'", str(raised.exception))

	def test_refuses_an_empty_list(self) -> None:
		"""A bump that stops emitting the types has to be read, not survived."""
		with self.assertRaises(ValueError):
			document_types([])


@unittest.skipUnless(BASE_APP.is_dir(), "run scripts/provision-vscode.sh for the Electron")
class StagedElectron(unittest.TestCase):
	"""The real list, from the bundle a build actually renames."""

	@classmethod
	def setUpClass(cls) -> None:
		staged = plistlib.loads((BASE_APP / "Contents" / "Info.plist").read_bytes())
		cls.types = document_types(staged.get("CFBundleDocumentTypes", []))

	def test_declares_markdown(self) -> None:
		extensions = {
			extension
			for entry in self.types
			for extension in entry.get("CFBundleTypeExtensions", [])
		}

		self.assertIn("md", extensions)
		self.assertIn("markdown", extensions)

	def test_declares_the_source_files_a_workspace_is_made_of(self) -> None:
		extensions = {
			extension
			for entry in self.types
			for extension in entry.get("CFBundleTypeExtensions", [])
		}

		self.assertLessEqual(
			{"ts", "tsx", "js", "json", "py", "rs", "go", "sh", "yaml", "toml", "txt"},
			extensions,
		)

	def test_is_a_plist_macos_will_accept(self) -> None:
		"""Round-trips through plistlib, which is what writes it into the bundle."""
		written = plistlib.dumps({"CFBundleDocumentTypes": self.types})

		self.assertEqual(
			plistlib.loads(written)["CFBundleDocumentTypes"], list(self.types)
		)


if __name__ == "__main__":
	unittest.main()
