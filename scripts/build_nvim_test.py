#!/usr/bin/env python3
"""The parts of build_nvim.py that decide, without the network.

What is pinned, when a download is the pinned asset, which glibc a binary
asks for, and when a directory counts as the Neovims to bundle.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build_nvim as bn


def elf_like(*versions: str) -> bytes:
	"""Bytes with the dynamic-string shape of a binary's glibc version needs."""
	return b"\x7fELF" + b"".join(f"GLIBC_{v}".encode() + b"\x00" for v in versions) + b"GLIBC_PRIVATE\x00"


def tarball(top: str, binary: bytes) -> bytes:
	out = io.BytesIO()
	with tarfile.open(fileobj=out, mode="w:gz") as archive:
		for name, data in ((f"{top}/bin/nvim", binary), (f"{top}/share/nvim/runtime/x.lua", b"--")):
			info = tarfile.TarInfo(name)
			info.size = len(data)
			archive.addfile(info, io.BytesIO(data))
	return out.getvalue()


class Pins(unittest.TestCase):
	def test_pins_a_tag_and_a_sha256_per_target(self) -> None:
		self.assertRegex(bn.NEOVIM_VERSION, r"^v\d+\.\d+\.\d+$")
		self.assertEqual(set(bn.TARGETS), {"linux-x64", "linux-arm64"})
		for target in bn.TARGETS.values():
			self.assertRegex(target.sha256, r"^[0-9a-f]{64}$")
			self.assertRegex(target.glibc, r"^2\.\d+$")

	def test_comes_from_the_owners_old_glibc_builds(self) -> None:
		self.assertEqual(
			bn.asset_url("linux-x64"),
			f"https://github.com/statiolake/neovim-binaries/releases/download/{bn.NEOVIM_VERSION}/nvim-linux-x86_64.tar.gz",
		)
		self.assertEqual(bn.TARGETS["linux-arm64"].asset, "nvim-linux-arm64.tar.gz")

	def test_statement_names_every_target(self) -> None:
		said = bn.statement()
		self.assertEqual(said["version"], bn.NEOVIM_VERSION)
		targets = said["targets"]
		assert isinstance(targets, dict)
		self.assertEqual(targets["linux-x64"]["file"], f"nvim-{bn.NEOVIM_VERSION}-linux-x64.tar.gz")
		self.assertEqual(targets["linux-x64"]["topLevelDirectory"], "nvim-linux-x86_64")
		self.assertEqual(targets["linux-arm64"]["glibc"], bn.TARGETS["linux-arm64"].glibc)


class NewestGlibc(unittest.TestCase):
	def test_reads_the_highest_version_named(self) -> None:
		self.assertEqual(bn.newest_glibc(elf_like("2.2.5", "2.14", "2.3.4")), "2.14")
		self.assertEqual(bn.newest_glibc(elf_like("2.17")), "2.17")

	def test_none_for_a_binary_without_glibc(self) -> None:
		self.assertIsNone(bn.newest_glibc(b"\x7fELF static"))


class TarballProblems(unittest.TestCase):
	def pinned(self, data: bytes, glibc: str = "2.14") -> mock._patch:
		target = bn.Target("nvim-linux-x86_64.tar.gz", hashlib.sha256(data).hexdigest(), "nvim-linux-x86_64", glibc)
		return mock.patch.dict(bn.TARGETS, {"linux-x64": target})

	def test_accepts_the_pinned_asset(self) -> None:
		data = tarball("nvim-linux-x86_64", elf_like("2.2.5", "2.14"))
		with self.pinned(data):
			self.assertEqual(bn.tarball_problems("linux-x64", data), [])

	def test_refuses_other_bytes(self) -> None:
		data = tarball("nvim-linux-x86_64", elf_like("2.14"))
		with self.pinned(data):
			problems = bn.tarball_problems("linux-x64", data + b"x")
		self.assertIn("not the pinned", problems[0])

	def test_refuses_a_binary_that_asks_for_a_newer_glibc(self) -> None:
		data = tarball("nvim-linux-x86_64", elf_like("2.14", "2.31"))
		with self.pinned(data):
			problems = bn.tarball_problems("linux-x64", data)
		self.assertIn("glibc 2.31", problems[0])

	def test_refuses_another_layout(self) -> None:
		data = tarball("nvim", elf_like("2.14"))
		with self.pinned(data):
			problems = bn.tarball_problems("linux-x64", data)
		self.assertIn("not one nvim-linux-x86_64/", problems[0])


class Install(unittest.TestCase):
	def test_installs_both_and_accepts_the_result(self) -> None:
		assets = {
			"linux-x64": tarball("nvim-linux-x86_64", elf_like("2.14")),
			"linux-arm64": tarball("nvim-linux-arm64", elf_like("2.17")),
		}
		targets = {
			name: bn.Target(bn.TARGETS[name].asset, hashlib.sha256(data).hexdigest(), bn.TARGETS[name].top_level_directory, bn.TARGETS[name].glibc)
			for name, data in assets.items()
		}
		fetched: list[str] = []

		def fetch(url: str) -> bytes:
			fetched.append(url)
			return next(data for name, data in assets.items() if url.endswith(bn.TARGETS[name].asset))

		with tempfile.TemporaryDirectory() as scratch, mock.patch.dict(bn.TARGETS, targets), mock.patch.dict(
			os.environ, {"DEVHUB_NVIM_CACHE": f"{scratch}/cache"}
		):
			out = Path(scratch) / "out"
			(out).mkdir()
			(out / "stale.tar.gz").write_bytes(b"old")
			bn.install(out, fetch=fetch)
			self.assertEqual(bn.install_problems(out), [])
			self.assertFalse((out / "stale.tar.gz").exists())
			self.assertEqual(json.loads((out / bn.STATEMENT).read_text()), bn.statement())
			# A second install is a copy out of the cache.
			bn.install(out, fetch=fetch)
			self.assertEqual(len(fetched), 2)

	def test_says_what_is_missing(self) -> None:
		with tempfile.TemporaryDirectory() as scratch:
			out = Path(scratch)
			self.assertIn("no readable", bn.install_problems(out)[0])
			(out / bn.STATEMENT).write_text(json.dumps(bn.statement()))
			problems = bn.install_problems(out)
			self.assertEqual(len(problems), 2)
			self.assertIn("is missing", problems[0])


if __name__ == "__main__":
	unittest.main()
