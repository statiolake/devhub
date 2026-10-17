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
		for name in ("vscode-submodule.sh", "apply-vscode-patches.sh", "vscode_export.py"):
			shutil.copy(SCRIPTS / name, root / "scripts" / name)
		git(root, "init", "-q", "-b", "main")
		git(root, "submodule", "add", "-q", f"file://{up}", "vscode")
		git(root / "vscode", "checkout", "-q", self.commits[0])
		git(root, "add", "vscode")
		git(root, "commit", "-qm", "pin 1")
		self.write_patch("1")
		self.overlay = root / "patches/vscode-overlay"
		self.write_overlay("src/devhub/b.ts", "export const b = 1;\n")

	def write_overlay(self, path: str, text: str):
		target = self.overlay / path
		target.parent.mkdir(parents=True, exist_ok=True)
		target.write_text(text)

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
		marker = git(self.root / "vscode", "rev-parse", "--git-path", "devhub-patched-tree.v2")
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

	def apply(self) -> subprocess.CompletedProcess:
		r = self.run_script("apply-vscode-patches.sh")
		self.assertEqual(r.returncode, 0, r.stderr)
		return r

	def test_overlay_is_copied_and_applying_twice_is_applying_once(self):
		self.apply()
		self.assertEqual((self.root / "vscode/src/devhub/b.ts").read_text(), "export const b = 1;\n")
		r = self.apply()
		self.assertIn("copied patches/vscode-overlay/ (1 files)", r.stdout)
		self.assertIn("'devhub'", (self.root / "vscode/src/a.ts").read_text())

	def test_an_overlay_file_upstream_has_too_is_refused(self):
		self.write_overlay("src/a.ts", "mine\n")
		r = self.run_script("apply-vscode-patches.sh")
		self.assertNotEqual(r.returncode, 0)
		self.assertIn("src/a.ts", r.stderr)
		self.assertIn("upstream has this file too", r.stderr)
		self.assertNotIn("mine", (self.root / "vscode/src/a.ts").read_text())

	def test_a_patch_into_an_overlay_file_is_refused(self):
		(self.root / "patches/vscode/0002.patch").write_text(
			"--- a/src/devhub/b.ts\n+++ b/src/devhub/b.ts\n@@ -1 +1 @@\n-export const b = 1;\n+export const b = 2;\n"
		)
		r = self.run_script("apply-vscode-patches.sh")
		self.assertNotEqual(r.returncode, 0)
		self.assertIn("src/devhub/b.ts: in patches/vscode-overlay/ and changed by a patch", r.stderr)

	def test_every_failing_patch_is_named(self):
		bad = "--- a/{f}\n+++ b/{f}\n@@ -1 +1 @@\n-nothing like this\n+x\n"
		(self.root / "patches/vscode/0002.patch").write_text(bad.format(f="package.json"))
		(self.root / "patches/vscode/0003.patch").write_text(bad.format(f="extensions/copilot/package.json"))
		r = self.run_script("apply-vscode-patches.sh")
		self.assertNotEqual(r.returncode, 0)
		self.assertIn("2 of 3 patches did not apply", r.stderr)
		self.assertIn("0002.patch", r.stderr)
		self.assertIn("0003.patch", r.stderr)
		# The one that applies is applied, and the tree stays DevHub's to reset.
		self.assertIn("'devhub'", (self.root / "vscode/src/a.ts").read_text())
		(self.root / "patches/vscode/0002.patch").unlink()
		(self.root / "patches/vscode/0003.patch").unlink()
		self.apply()

	def test_an_edit_to_an_overlay_file_in_the_tree_stops_the_reset(self):
		self.apply()
		(self.root / "vscode/src/devhub/b.ts").write_text("export const b = 'mine';\n")
		r = self.run_script("apply-vscode-patches.sh")
		self.assertNotEqual(r.returncode, 0)
		self.assertIn("src/devhub/b.ts", r.stderr)
		self.assertIn("mine", (self.root / "vscode/src/devhub/b.ts").read_text())

	def marker(self, name: str) -> Path:
		return Path(self.root / "vscode", git(self.root / "vscode", "rev-parse", "--git-path", name))

	def test_a_tree_recorded_in_the_first_format_resets(self):
		# What the scripts before the overlay recorded: the tree's diff plus
		# the untracked files' names, without their contents.
		self.apply()
		self.marker("devhub-patched-tree.v2").unlink()
		vscode = self.root / "vscode"
		changes = git(vscode, "diff", "--binary", "HEAD", "--", ".", ":(exclude)extensions/copilot/package.json")
		changes += "\n" + git(vscode, "ls-files", "--others", "--exclude-standard")
		legacy = subprocess.run(
			["git", "hash-object", "--stdin"], input=changes, cwd=vscode, env=ENV,
			capture_output=True, text=True, check=True,
		).stdout.strip()
		self.marker("devhub-patched-tree").write_text(legacy + "\n")
		self.apply()
		self.assertFalse(self.marker("devhub-patched-tree").exists())
		self.assertTrue(self.marker("devhub-patched-tree.v2").exists())

	def test_an_unrecorded_tree_of_patches_and_overlay_resets(self):
		self.apply()
		self.marker("devhub-patched-tree.v2").unlink()
		self.apply()
		self.marker("devhub-patched-tree.v2").unlink()
		(self.root / "vscode/src/devhub/b.ts").write_text("changed\n")
		r = self.run_script("apply-vscode-patches.sh")
		self.assertNotEqual(r.returncode, 0)

	def test_source_state_follows_the_overlay(self):
		state = lambda: self.run_script("vscode-submodule.sh", "source-state").stdout.strip()
		before = state()
		self.assertRegex(before, r"^[0-9a-f]{40}$")
		self.assertEqual(state(), before)
		self.write_overlay("src/devhub/b.ts", "export const b = 2;\n")
		self.assertNotEqual(state(), before)

	def export(self) -> subprocess.CompletedProcess:
		return self.run_script("vscode-submodule.sh", "export")

	def test_export_writes_each_change_back_to_its_half(self):
		self.apply()
		vscode = self.root / "vscode"
		(vscode / "src/a.ts").write_text("export const a = 'devhub, edited';\n")
		(vscode / "src/devhub/b.ts").write_text("export const b = 2;\n")
		(vscode / "src/devhub/c.ts").write_text("export const c = 3;\n")
		(vscode / "src/newdir").mkdir()
		(vscode / "src/newdir/d.ts").write_text("export const d = 4;\n")
		r = self.export()
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertIn("devhub, edited", (self.root / "patches/vscode/0001.patch").read_text())
		self.assertEqual((self.overlay / "src/devhub/b.ts").read_text(), "export const b = 2;\n")
		self.assertEqual((self.overlay / "src/devhub/c.ts").read_text(), "export const c = 3;\n")
		self.assertEqual((self.overlay / "src/newdir/d.ts").read_text(), "export const d = 4;\n")
		# Exported means recorded: the tree is DevHub's again, and applying
		# what was written gives the same tree back.
		before = {p: (vscode / p).read_text() for p in ("src/a.ts", "src/devhub/b.ts", "src/devhub/c.ts")}
		self.apply()
		self.assertEqual({p: (vscode / p).read_text() for p in before}, before)

	def test_export_of_an_unchanged_tree_writes_nothing(self):
		self.apply()
		patch = (self.root / "patches/vscode/0001.patch").read_text()
		r = self.export()
		self.assertEqual(r.returncode, 0, r.stderr)
		self.assertIn("already say what vscode/ does", r.stdout)
		self.assertEqual((self.root / "patches/vscode/0001.patch").read_text(), patch)

	def test_export_refuses_what_it_cannot_decide_and_writes_nothing(self):
		self.apply()
		vscode = self.root / "vscode"
		(vscode / "package.json").write_text('{ "version": "mine" }\n')  # no patch changes it
		(vscode / "src/scratch.ts").write_text("x\n")  # new, in a directory upstream has
		(vscode / "src/devhub/b.ts").unlink()  # an overlay file gone from the tree
		(vscode / "src/a.ts").write_text("export const a = 'edited';\n")
		patch = (self.root / "patches/vscode/0001.patch").read_text()
		r = self.export()
		self.assertNotEqual(r.returncode, 0)
		for path in ("package.json", "src/scratch.ts", "src/devhub/b.ts"):
			self.assertIn(path, r.stderr)
		self.assertIn("nothing was written", r.stderr)
		self.assertEqual((self.root / "patches/vscode/0001.patch").read_text(), patch)
		self.assertFalse((self.overlay / "src/scratch.ts").exists())
		self.assertTrue((self.overlay / "src/devhub/b.ts").exists())

	def test_export_refuses_a_patch_whose_changes_are_all_gone(self):
		self.apply()
		git(self.root / "vscode", "checkout", "--", "src/a.ts")
		r = self.export()
		self.assertNotEqual(r.returncode, 0)
		self.assertIn("0001.patch: none of its changes", r.stderr)

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


class Bash32CompatTest(unittest.TestCase):
    """Static guard: macOS ships bash 3.2, so scripts/*.sh must avoid
    bash 4+ constructs."""

    FORBIDDEN = [
        (r"\bmapfile\b", "mapfile"),
        (r"\breadarray\b", "readarray"),
        (r"\bdeclare\s+-[a-zA-Z]*[An]\b", "declare -A/-n"),
        (r"\$\{[A-Za-z_][A-Za-z_0-9]*(,,|\^\^|,|\^)[^}]*\}", "case-modifying expansion"),
        (r"\|&", "|&"),
        (r"&>>", "&>>"),
        (r"\[-[0-9]+\]|\$\{[A-Za-z_0-9]+:\s+-[0-9]+[:}]", "negative array index"),
    ]

    def test_no_bash4_constructs(self):
        import glob
        import re
        here = os.path.dirname(os.path.abspath(__file__))
        problems = []
        for path in sorted(glob.glob(os.path.join(here, "*.sh"))):
            with open(path) as fh:
                for n, line in enumerate(fh, 1):
                    if line.lstrip().startswith("#"):
                        continue
                    for pat, name in self.FORBIDDEN:
                        if re.search(pat, line):
                            problems.append(f"{os.path.basename(path)}:{n}: {name}")
        self.assertEqual(problems, [])
