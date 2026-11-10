#!/usr/bin/env python3
"""The tools release: its names, its tarball's layout, and the pins the app
build checks it against.

`scripts/build_tools.py` writes the tarball, `.github/workflows/tools.yml`
publishes it, and `apps/desktop/scripts/fetch-binaries.mjs` downloads it by
the URL `apps/desktop/product.json` states. Nothing checks at runtime that
these agree. If they do not, the app build fails with a 404 or with a sha256
that does not match.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import io
import tarfile
import tempfile
import unittest
from pathlib import Path

from build_tools import TOOLS, check_layout, pack, release_tag, tarball_name, top_level_dir
from build_tmux import TARGETS

REPO_ROOT = Path(__file__).resolve().parent.parent


class Names(unittest.TestCase):
	def test_names(self) -> None:
		self.assertEqual(release_tag("1"), "tools-1")
		self.assertEqual(tarball_name("1", "linux-x64"), "devhub-tools-1-linux-x64.tar.gz")
		self.assertEqual(top_level_dir("linux-arm64"), "devhub-tools-linux-arm64")


class Layout(unittest.TestCase):
	def setUp(self) -> None:
		self.work = Path(tempfile.mkdtemp())

	def tool_tarball(self, tool: str) -> Path:
		path = self.work / f"devhub-{tool}-linux-x64-{TOOLS[tool]}.tar.gz"
		with tarfile.open(path, "w:gz") as archive:
			info = tarfile.TarInfo(f"devhub-{tool}-linux-x64/bin/{tool}")
			info.mode = 0o755
			archive.addfile(info, io.BytesIO(b""))
		return path

	def test_pack_writes_what_check_layout_and_the_app_read(self) -> None:
		built = {tool: self.tool_tarball(tool) for tool in TOOLS}
		tarball = pack("7", "linux-x64", built, self.work / "out")
		self.assertEqual(tarball.name, "devhub-tools-7-linux-x64.tar.gz")
		manifest = check_layout(tarball, "linux-x64")
		self.assertEqual(manifest["toolsVersion"], "7")
		self.assertEqual(manifest["platform"], "linux-x64")
		self.assertEqual(
			{tool: entry["file"] for tool, entry in manifest["tools"].items()},
			{tool: path.name for tool, path in built.items()},
		)

	def test_refuses_a_tool_tarball_that_is_not_what_tools_json_states(self) -> None:
		built = {tool: self.tool_tarball(tool) for tool in TOOLS}
		tarball = pack("7", "linux-x64", built, self.work / "out")
		with tarfile.open(tarball) as archive:
			members = [(m, archive.extractfile(m)) for m in archive.getmembers()]
			contents = {m.name: (m, f.read() if f else b"") for m, f in members}
		broken = self.work / "broken.tar.gz"
		with tarfile.open(broken, "w:gz") as archive:
			for name, (member, data) in contents.items():
				if name.endswith(".tar.gz") and "bash" in name:
					data = b"something else"
					member.size = len(data)
				archive.addfile(member, io.BytesIO(data))
		with self.assertRaises(SystemExit):
			check_layout(broken, "linux-x64")


class Workflow(unittest.TestCase):
	"""The workflow that publishes it, read as text."""

	def setUp(self) -> None:
		self.workflow = (REPO_ROOT / ".github" / "workflows" / "tools.yml").read_text()

	def test_builds_every_target_on_a_runner_of_its_own(self) -> None:
		for target, runner in (
			("darwin-arm64", "macos-14"),
			("linux-x64", "ubuntu-latest"),
			("linux-arm64", "ubuntu-24.04-arm"),
		):
			with self.subTest(target=target):
				self.assertIn(f"- target: {target}\n            runner: {runner}", self.workflow)
		self.assertEqual(set(TARGETS), {"darwin-arm64", "linux-x64", "linux-arm64"})

	def test_runs_on_the_tag_and_checks_it_against_the_script(self) -> None:
		self.assertIn('tags: ["tools-*"]', self.workflow)
		self.assertIn("scripts/build_tools.py --print-version", self.workflow)
		self.assertIn('"tools-$version"', self.workflow)

	def test_publishes_sha256sums_beside_the_tarballs(self) -> None:
		self.assertIn("dist/devhub-tools-*.tar.gz dist/SHA256SUMS", self.workflow)

	def test_nightly_publishes_no_tool_release_of_its_own(self) -> None:
		nightly = (REPO_ROOT / ".github" / "workflows" / "nightly.yml").read_text()
		for script in ("build_tmux.py", "build_bash.py", "build_tools.py"):
			with self.subTest(script=script):
				self.assertNotIn(f"scripts/{script} ${{{{", nightly)
		self.assertEqual(nightly.count("gh release create"), 1)


if __name__ == "__main__":
	unittest.main()
