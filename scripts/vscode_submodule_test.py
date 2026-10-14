#!/usr/bin/env python3
"""scripts/vscode-submodule.sh follows a bump and keeps a developer's edits."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent

ENV = {
	**os.environ,
	"GIT_CONFIG_COUNT": "1",
	"GIT_CONFIG_KEY_0": "protocol.file.allow",
	"GIT_CONFIG_VALUE_0": "always",
	"GIT_AUTHOR_NAME": "t",
	"GIT_AUTHOR_EMAIL": "t@t",
	"GIT_COMMITTER_NAME": "t",
	"GIT_COMMITTER_EMAIL": "t@t",
}
ENV.pop("DEVHUB_DISCARD_VSCODE_CHANGES", None)

PATCH = """\
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = {old};
+export const a = 'devhub';
"""


def git(cwd: Path, *args: str) -> str:
	return subprocess.run(
		["git", *args], cwd=cwd, env=ENV, check=True, capture_output=True, text=True
	).stdout.strip()


class SubmoduleTest(unittest.TestCase):
	def setUp(self):
		self.tmp = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, self.tmp)
		up = self.tmp / "upstream"
		(up / "src").mkdir(parents=True)
		git(up, "init", "-q", "-b", "main")
		self.commits = []
		for version in ("1.0.0", "2.0.0"):
			(up / "package.json").write_text(f'{{\n  "version": "{version}"\n}}\n')
			(up / "extensions/copilot").mkdir(parents=True, exist_ok=True)
			(up / "extensions/copilot/package.json").write_text('{ "version": "0.1.0" }\n')
			(up / "src/a.ts").write_text(f"export const a = {version[0]};\n")
			git(up, "add", "-A")
			git(up, "commit", "-qm", version)
			self.commits.append(git(up, "rev-parse", "HEAD"))
		git(up, "config", "uploadpack.allowAnySHA1InWant", "true")

		self.root = root = self.tmp / "super"
		(root / "scripts").mkdir(parents=True)
		for name in ("vscode-submodule.sh", "apply-vscode-patches.sh"):
			shutil.copy(SCRIPTS / name, root / "scripts" / name)
		git(root, "init", "-q", "-b", "main")
		git(root, "submodule", "add", "-q", f"file://{up}", "vscode")
		git(root / "vscode", "checkout", "-q", self.commits[0])
		git(root, "add", "vscode")
		git(root, "commit", "-qm", "pin 1")
		self.write_patch("1")

	def write_patch(self, old: str):
		d = self.root / "patches/vscode"
		d.mkdir(parents=True, exist_ok=True)
		(d / "0001.patch").write_text(PATCH.format(old=old))

	def run_script(self, *args: str, env=None) -> subprocess.CompletedProcess:
		return subprocess.run(
			[str(self.root / "scripts" / args[0]), *args[1:]],
			env={**ENV, **(env or {})},
			capture_output=True,
			text=True,
		)

	def bump(self):
		git(self.root, "update-index", "--cacheinfo", f"160000,{self.commits[1]},vscode")
		self.write_patch("2")

	def head(self) -> str:
		return git(self.root / "vscode", "rev-parse", "HEAD")

	def test_in_sync_is_a_no_op(self):
		r = self.run_script("vscode-submodule.sh", "sync")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertIn("checked out:", r.stdout)
		self.assertIn("VS Code 1.0.0", r.stdout)

	def test_bump_on_a_patched_tree_reverts_and_updates(self):
		r = self.run_script("apply-vscode-patches.sh")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.bump()
		r = self.run_script("vscode-submodule.sh", "sync")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertEqual(self.head(), self.commits[1])
		self.assertIn("updated vscode:", r.stdout)
		self.assertIn("→", r.stdout)
		self.assertIn("(VS Code 2.0.0)", r.stdout)
		r = self.run_script("apply-vscode-patches.sh")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertIn("'devhub'", (self.root / "vscode/src/a.ts").read_text())

	def test_tree_patched_before_the_marker_existed(self):
		r = self.run_script("apply-vscode-patches.sh")
		self.assertEqual(r.returncode, 0, r.stderr)
		marker = git(self.root / "vscode", "rev-parse", "--git-path", "devhub-patched-tree")
		Path(self.root / "vscode", marker).unlink()
		self.bump()
		r = self.run_script("vscode-submodule.sh", "sync")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertEqual(self.head(), self.commits[1])

	def test_developer_edit_stops_the_sync(self):
		r = self.run_script("apply-vscode-patches.sh")
		self.assertEqual(r.returncode, 0, r.stderr)
		(self.root / "vscode/package.json").write_text('{ "version": "mine" }\n')
		self.bump()
		r = self.run_script("vscode-submodule.sh", "sync")
		self.assertNotEqual(r.returncode, 0)
		self.assertIn("package.json", r.stderr)
		self.assertEqual(self.head(), self.commits[0])
		self.assertIn("mine", (self.root / "vscode/package.json").read_text())

	def build_writes_copilot_package_json(self):
		# What `gulp compile-copilot-extension-build` does with CI set.
		(self.root / "vscode/extensions/copilot/package.json").write_text(
			'{ "version": "0.1.0", "isPreRelease": false }\n'
		)

	def test_build_written_copilot_package_json_resets(self):
		r = self.run_script("apply-vscode-patches.sh")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.build_writes_copilot_package_json()
		r = self.run_script("apply-vscode-patches.sh")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertNotIn(
			"isPreRelease", (self.root / "vscode/extensions/copilot/package.json").read_text()
		)
		self.build_writes_copilot_package_json()
		self.bump()
		r = self.run_script("vscode-submodule.sh", "sync")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertEqual(self.head(), self.commits[1])

	def test_build_written_file_plus_developer_edit_stops(self):
		r = self.run_script("apply-vscode-patches.sh")
		self.assertEqual(r.returncode, 0, r.stderr)
		self.build_writes_copilot_package_json()
		(self.root / "vscode/package.json").write_text('{ "version": "mine" }\n')
		r = self.run_script("apply-vscode-patches.sh")
		self.assertNotEqual(r.returncode, 0)
		self.assertIn("mine", (self.root / "vscode/package.json").read_text())

	def test_untracked_file_stops_the_reset(self):
		(self.root / "vscode/src/mine.ts").write_text("x\n")
		r = self.run_script("apply-vscode-patches.sh")
		self.assertNotEqual(r.returncode, 0)
		self.assertTrue((self.root / "vscode/src/mine.ts").exists())

	def test_discard_override(self):
		(self.root / "vscode/package.json").write_text('{ "version": "mine" }\n')
		self.bump()
		r = self.run_script(
			"vscode-submodule.sh", "sync", env={"DEVHUB_DISCARD_VSCODE_CHANGES": "1"}
		)
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertEqual(self.head(), self.commits[1])


if __name__ == "__main__":
	unittest.main()
