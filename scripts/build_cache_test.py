#!/usr/bin/env python3
"""Keys and skip decisions of the cached packaging steps.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_cache as bc  # noqa: E402


def write(path: Path, text: str = "x") -> Path:
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text(text)
	return path


class ExtensionsKey(unittest.TestCase):
	def setUp(self) -> None:
		self.tmp = tempfile.TemporaryDirectory()
		self.root = Path(self.tmp.name)
		self.patches = self.root / "patches"
		write(self.patches / "0001-a.patch", "a")
		self.ext = self.root / "extensions"
		write(self.ext / "git" / "src" / "a.ts", "1")
		self.product = write(
			self.root / "product.json",
			json.dumps({"builtInExtensions": [{"name": "x", "version": "1"}]}),
		)

	def tearDown(self) -> None:
		self.tmp.cleanup()

	def key(self, **over) -> str:
		args = dict(
			vscode_commit="abc", patches_dir=self.patches, extensions_dir=self.ext,
			build_dir=None, product_json=self.product, node_version="22.1.0",
		)
		args.update(over)
		return bc.extensions_key(**args)

	def test_stable(self) -> None:
		self.assertEqual(self.key(), self.key())

	def test_each_input_changes_it(self) -> None:
		base = self.key()
		self.assertNotEqual(base, self.key(vscode_commit="def"))
		self.assertNotEqual(base, self.key(node_version="22.2.0"))
		write(self.patches / "0001-a.patch", "changed")
		self.assertNotEqual(base, self.key())

	def test_new_patch_changes_it(self) -> None:
		base = self.key()
		write(self.patches / "0002-b.patch", "b")
		self.assertNotEqual(base, self.key())

	def test_extension_source_change_changes_it(self) -> None:
		base = self.key()
		write(self.ext / "git" / "src" / "a.ts", "22")
		self.assertNotEqual(base, self.key())

	def test_node_modules_and_out_are_ignored(self) -> None:
		base = self.key()
		write(self.ext / "git" / "node_modules" / "m" / "i.js")
		write(self.ext / "git" / "out" / "a.js")
		self.assertEqual(base, self.key())

	def test_builtin_extensions_entries_change_it(self) -> None:
		base = self.key()
		write(self.product, json.dumps({"builtInExtensions": [{"name": "x", "version": "2"}]}))
		self.assertNotEqual(base, self.key())

	def test_other_product_fields_do_not(self) -> None:
		base = self.key()
		write(
			self.product,
			json.dumps({"nameLong": "z", "builtInExtensions": [{"name": "x", "version": "1"}]}),
		)
		self.assertEqual(base, self.key())


class StampDecision(unittest.TestCase):
	def test_decisions(self) -> None:
		with tempfile.TemporaryDirectory() as t:
			root = Path(t)
			out, stamp = root / "extensions", root / "extensions.stamp"
			self.assertFalse(bc.stamp_decision(stamp, out, "k")[0])  # no output
			out.mkdir()
			self.assertIn("no stamp", bc.stamp_decision(stamp, out, "k")[1])
			bc.write_stamp(stamp, "old")
			self.assertIn("changed", bc.stamp_decision(stamp, out, "k")[1])
			bc.write_stamp(stamp, "k")
			self.assertTrue(bc.stamp_decision(stamp, out, "k")[0])
			out.rmdir()
			self.assertFalse(bc.stamp_decision(stamp, out, "k")[0])


class AsarCache(unittest.TestCase):
	def setUp(self) -> None:
		self.tmp = tempfile.TemporaryDirectory()
		self.root = Path(self.tmp.name)
		self.vscode = self.root / "vscode"
		self.mod = self.vscode / "node_modules" / "left-pad"
		write(self.mod / "package.json", '{"version":"1.0.0"}')
		write(self.mod / "index.js", "a")
		self.packer = write(self.root / "pack.mjs", "p")

	def tearDown(self) -> None:
		self.tmp.cleanup()

	def key(self, **over) -> str:
		args = dict(
			modules=[self.mod], root=self.vscode, packer=self.packer, asar_library=None,
			node_version="22.1.0", extra_rules="r1",
		)
		args.update(over)
		return bc.asar_key(**args)

	def test_stable_and_sensitive(self) -> None:
		base = self.key()
		self.assertEqual(base, self.key())
		self.assertNotEqual(base, self.key(node_version="23"))
		self.assertNotEqual(base, self.key(extra_rules="r2"))
		other = self.vscode / "node_modules" / "other"
		write(other / "package.json", "{}")
		self.assertNotEqual(base, self.key(modules=[self.mod, other]))
		write(self.packer, "p2")
		self.assertNotEqual(base, self.key())

	def test_package_contents_or_mtime_change_it(self) -> None:
		base = self.key()
		write(self.mod / "index.js", "bb")
		self.assertNotEqual(base, self.key())
		write(self.mod / "index.js", "a")
		os.utime(self.mod / "index.js", (1, 1))
		self.assertNotEqual(base, self.key())

	def test_nested_node_modules_are_not_part_of_the_package(self) -> None:
		base = self.key()
		write(self.mod / "node_modules" / "n" / "x.js")
		self.assertEqual(base, self.key())

	def test_store_hit_restore(self) -> None:
		cache = self.root / "dist" / ".cache" / "asar"
		code = self.root / "code"
		write(code / "node_modules.asar", "ASAR")
		write(code / "node_modules.asar.unpacked" / "a" / "b.node", "BIN")
		write(code / "node_modules" / "vsda" / "x.js", "dup")
		self.assertIsNone(bc.asar_cache_hit(cache, "k1"))
		bc.asar_cache_store(cache, "k1", code)
		self.assertIsNotNone(bc.asar_cache_hit(cache, "k1"))
		self.assertIsNone(bc.asar_cache_hit(cache, "k2"))
		fresh = self.root / "fresh"
		fresh.mkdir()
		entry = bc.asar_cache_hit(cache, "k1")
		assert entry is not None
		bc.asar_cache_restore(entry, fresh)
		self.assertEqual((fresh / "node_modules.asar").read_text(), "ASAR")
		self.assertEqual((fresh / "node_modules.asar.unpacked" / "a" / "b.node").read_text(), "BIN")
		self.assertEqual((fresh / "node_modules" / "vsda" / "x.js").read_text(), "dup")

	def test_new_key_evicts_old_and_incomplete_is_a_miss(self) -> None:
		cache = self.root / "c"
		code = self.root / "code"
		write(code / "node_modules.asar", "A")
		bc.asar_cache_store(cache, "k1", code)
		bc.asar_cache_store(cache, "k2", code)
		self.assertIsNone(bc.asar_cache_hit(cache, "k1"))
		(cache / "k2" / ".complete").unlink()
		self.assertIsNone(bc.asar_cache_hit(cache, "k2"))


class ZipCommand(unittest.TestCase):
	def test_levels(self) -> None:
		app, out = Path("/o/DevHub.app"), Path("/o/x.zip")
		argv, cwd = bc.zip_command(app, out, "1")
		self.assertEqual(argv, ["zip", "-r", "-y", "-q", "-1", "/o/x.zip", "DevHub.app"])
		self.assertEqual(cwd, Path("/o"))
		self.assertIn("-0", bc.zip_command(app, out, "0")[0])
		self.assertEqual(bc.zip_command(app, out, "ditto")[0][:3], ["ditto", "-c", "-k"])
		with self.assertRaises(ValueError):
			bc.zip_command(app, out, "10")

	def test_zip_keeps_symlinks_and_extracts(self) -> None:
		import shutil
		import subprocess

		if not shutil.which("zip") or not shutil.which("unzip"):
			self.skipTest("zip/unzip not installed")
		with tempfile.TemporaryDirectory() as t:
			root = Path(t)
			app = root / "A.app"
			write(app / "Contents" / "f.txt", "hello" * 100)
			os.symlink("f.txt", app / "Contents" / "link")
			archive = root / "a.zip"
			argv, cwd = bc.zip_command(app, archive, "1")
			subprocess.run(argv, cwd=cwd, check=True)
			out = root / "out"
			subprocess.run(["unzip", "-q", str(archive), "-d", str(out)], check=True)
			self.assertTrue((out / "A.app" / "Contents" / "link").is_symlink())
			self.assertEqual((out / "A.app" / "Contents" / "f.txt").read_text(), "hello" * 100)


if __name__ == "__main__":
	unittest.main()
