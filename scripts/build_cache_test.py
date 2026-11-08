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
