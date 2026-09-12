#!/usr/bin/env python3
"""The URL the remote fetches has to be the URL CI published.

There is no handshake between the two. The extension reads
`serverDownloadUrlTemplate` out of DevHub's `product.json`, substitutes six
names into it with `sed` on the remote machine, and downloads whatever comes
back; the nightly workflow, on the other side, names a file with
`scripts/build_reh.py` and uploads it to a release. If those two disagree by one
character the only symptom is "Error downloading server from <url>" in a log
nobody is looking at.

So the template and the namer are checked against each other here, by doing to
the template exactly what the remote's `sed` does to it.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from build_reh import (
	COPILOT_KEPT,
	TARGETS,
	gulp_task,
	release_tag,
	remove_copilot,
	tarball_name,
	top_level_dir,
)
from product_metadata import PRODUCT_OVERRIDES, vscode_commit

# A hash of the right shape that is obviously not a real one.
COMMIT = "0" * 32 + "abcdef01"

# What `src/scripts/server-setup.sh` in jeanp413/open-remote-ssh substitutes,
# and the whole of it: the script runs one `sed` per name and leaves anything
# else in the URL alone.
PLACEHOLDERS = ("quality", "version", "commit", "os", "arch", "release")

# The two DevHub does not state. `product.json` has no `quality` and no
# `release`, and the extension turns a missing one into the string "undefined"
# (PowerShell) or into nothing at all (sh) instead of refusing to continue — so
# a template that mentions either resolves to an address that is wrong without
# saying so.
UNSTATED_PLACEHOLDERS = ("quality", "release")

TEMPLATE = PRODUCT_OVERRIDES["serverDownloadUrlTemplate"]


def resolve(template: str, **values: str) -> str:
	"""Substitute like the remote does, and leave the rest standing."""
	for name, value in values.items():
		template = template.replace("${" + name + "}", value)
	return template


class DownloadTemplate(unittest.TestCase):
	def test_resolves_to_the_file_the_build_produces(self) -> None:
		for target in TARGETS:
			os_name, _, arch = target.partition("-")
			with self.subTest(target=target):
				url = resolve(TEMPLATE, os=os_name, arch=arch, commit=COMMIT)
				self.assertEqual(
					url,
					"https://github.com/statiolake/devhub/releases/download/"
					f"{release_tag(COMMIT)}/{tarball_name(os_name, arch, COMMIT)}",
				)

	def test_leaves_nothing_to_substitute(self) -> None:
		url = resolve(TEMPLATE, os="linux", arch="x64", commit=COMMIT)
		self.assertNotIn("${", url)

	def test_names_only_placeholders_devhub_states(self) -> None:
		named = set(re.findall(r"\$\{(\w+)\}", TEMPLATE))
		self.assertTrue(named <= set(PLACEHOLDERS), f"unknown placeholders in {named}")
		self.assertFalse(named & set(UNSTATED_PLACEHOLDERS))
		for key in UNSTATED_PLACEHOLDERS:
			self.assertNotIn(key, PRODUCT_OVERRIDES)

	def test_points_at_github_so_the_extension_can_read_it(self) -> None:
		# `fetchRelease` in the extension refuses to look up releases on any
		# other host, and falls back to the client's own version. That fallback
		# is what DevHub wants anyway (`serverVersion: match`), but the URL
		# still has to be a URL the extension's `new URL(...)` accepts.
		self.assertTrue(TEMPLATE.startswith("https://github.com/statiolake/devhub/"))


class ServerNames(unittest.TestCase):
	"""The names the remote install script looks for once it has unpacked."""

	def test_states_the_launcher_script_name(self) -> None:
		# The script runs `$SERVER_DIR/bin/$SERVER_APP_NAME` and reports
		# "server contents are corrupted" if it is not there. The build names
		# that file after this key, so it has to exist for the tarball to have
		# a launcher at all.
		self.assertEqual(PRODUCT_OVERRIDES["serverApplicationName"], "devhub-server")

	def test_states_where_the_remote_keeps_it(self) -> None:
		self.assertEqual(PRODUCT_OVERRIDES["serverDataFolderName"], ".devhub-server")


class BuildNames(unittest.TestCase):
	def test_gulp_task_is_the_packaging_half(self) -> None:
		# `-min-ci`, not `-min`: the difference is the mangling compile, which
		# does not complete on 1.136.1. See gulp_task's docstring.
		self.assertEqual(gulp_task("linux", "arm64"), "vscode-reh-linux-arm64-min-ci")

	def test_every_target_has_its_own_tarball(self) -> None:
		names = {tarball_name(*t.partition("-")[::2], COMMIT) for t in TARGETS}
		self.assertEqual(len(names), len(TARGETS))

	def test_tarball_has_one_top_level_directory(self) -> None:
		# `tar --strip-components 1` needs exactly one, and it must not be the
		# tarball's own name with `.tar.gz` still on it.
		self.assertEqual(top_level_dir("linux", "x64"), "devhub-reh-linux-x64")

	def test_release_tag_is_keyed_on_the_vs_code_commit(self) -> None:
		# Not on a date and not on DevHub's commit: the REH is a function of
		# the submodule, and `${commit}` is the only placeholder that can
		# identify a build. See build_reh.py.
		self.assertEqual(release_tag(vscode_commit()), f"reh-{vscode_commit()}")


class RemoveCopilot(unittest.TestCase):
	"""Which parts of the built tree the deletion takes, and which it leaves.

	The whole reason `remove_copilot` is a deletion rather than a build option
	is written down in its docstring; what matters here is that it deletes the
	two big things, keeps the two small ones `server-main.js` reads versions
	out of, and refuses to be a silent no-op if upstream renames either.
	"""

	def setUp(self) -> None:
		self.staging = Path(tempfile.mkdtemp(prefix="reh-test-"))
		self.addCleanup(lambda: __import__("shutil").rmtree(self.staging, ignore_errors=True))

	def write(self, relative: str, size: int = 1024) -> Path:
		path = self.staging / relative
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_bytes(b"\0" * size)
		return path

	def test_takes_the_extension_and_the_platform_runtime(self) -> None:
		extension = self.write("extensions/copilot/dist/extension.js")
		runtime = self.write("node_modules/@github/copilot-linux-x64/prebuilds/runtime.node")
		other = self.write("extensions/git/dist/main.js")

		remove_copilot(self.staging, "linux", "x64")

		self.assertFalse(extension.parent.parent.exists())
		self.assertFalse(runtime.parent.parent.exists())
		self.assertTrue(other.exists())

	def test_keeps_what_startup_reads_versions_from(self) -> None:
		self.write("extensions/copilot/dist/extension.js")
		kept = [self.write(f"{package}/package.json") for package in COPILOT_KEPT]

		remove_copilot(self.staging, "linux", "x64")

		for path in kept:
			self.assertTrue(path.exists(), path)

	def test_refuses_to_find_nothing(self) -> None:
		# A tree with no Copilot in it means the build changed under us, and a
		# quietly smaller server is the kind of difference nobody traces back.
		self.write("extensions/git/dist/main.js")
		with self.assertRaises(SystemExit):
			remove_copilot(self.staging, "linux", "x64")


if __name__ == "__main__":
	unittest.main()
