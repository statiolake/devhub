#!/usr/bin/env python3
"""The product facts the app reads, and what a packaged build adds to them."""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from product_metadata import PRODUCT, devhub_version, packaged_product  # noqa: E402


class Product(unittest.TestCase):
	def test_names_devhub(self) -> None:
		self.assertEqual(PRODUCT["nameShort"], "DevHub")
		self.assertEqual(PRODUCT["darwinBundleIdentifier"], "net.statiolake.devhub")

	def test_states_no_build_of_its_own(self) -> None:
		# Only a packaged app says which commit it is; a source run says it has none.
		self.assertNotIn("commit", PRODUCT)
		self.assertNotIn("version", PRODUCT)

	def test_says_nothing_of_vs_code(self) -> None:
		for key in ("extensionsGallery", "serverApplicationName", "serverCommit", "serverIdentity"):
			self.assertNotIn(key, PRODUCT)

	def test_puts_no_node_on_a_host(self) -> None:
		# The devhub command is a Go binary carried in the app (docs/devhub-cli.md).
		for key in ("nodeVersion", "nodeDownloadUrlTemplate", "nodeDownloadSha256"):
			self.assertNotIn(key, PRODUCT)


class PackagedProduct(unittest.TestCase):
	def test_adds_the_version_and_the_commit(self) -> None:
		packaged = packaged_product()
		self.assertEqual(packaged["version"], devhub_version())
		self.assertTrue(re.fullmatch(r"[0-9a-f]{40}", str(packaged["commit"])))
		self.assertEqual(packaged["nameShort"], PRODUCT["nameShort"])


if __name__ == "__main__":
	unittest.main()
