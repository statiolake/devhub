#!/usr/bin/env python3
"""What DevHub tells macOS about itself.

`CFBundleDocumentTypes` is the only reason DevHub appears in Finder's "Open
With" for a Markdown file. These tests pin what the list must hold: the
extensions, a rank that never steals somebody's default, one entry per
extension, and DevHub's own icon. They need no Mac and no Electron.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import unittest

from darwin_bundle import (
	APP_NAME,
	BUNDLE_IDENTIFIER,
	DOCUMENT_EXTENSIONS,
	ICON_FILE,
	MICROPHONE_USAGE,
	document_types,
)


class DocumentTypes(unittest.TestCase):
	def test_offers_the_text_and_source_formats(self) -> None:
		extensions = {
			extension for entry in document_types() for extension in entry["CFBundleTypeExtensions"]
		}
		for wanted in ("md", "txt", "json", "toml", "ts", "py", "rs", "go", "sh"):
			self.assertIn(wanted, extensions)

	def test_ranks_every_type_alternate(self) -> None:
		"""Installing DevHub must never change what double-clicking a file does."""
		self.assertEqual({entry["LSHandlerRank"] for entry in document_types()}, {"Alternate"})

	def test_opens_rather_than_views(self) -> None:
		self.assertEqual({entry["CFBundleTypeRole"] for entry in document_types()}, {"Editor"})

	def test_wears_devhubs_icon(self) -> None:
		self.assertEqual({entry["CFBundleTypeIconFile"] for entry in document_types()}, {ICON_FILE.name})

	def test_declares_each_extension_once(self) -> None:
		every = [extension for extensions in DOCUMENT_EXTENSIONS.values() for extension in extensions]
		self.assertEqual(len(every), len(set(every)))


class Identity(unittest.TestCase):
	def test_is_devhubs(self) -> None:
		self.assertEqual(APP_NAME, "DevHub")
		self.assertEqual(BUNDLE_IDENTIFIER, "net.statiolake.devhub")

	def test_asks_for_the_microphone_in_devhubs_words(self) -> None:
		self.assertIn("DevHub", MICROPHONE_USAGE)


if __name__ == "__main__":
	unittest.main()
