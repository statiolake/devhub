#!/usr/bin/env python3
"""The servers DevHub carries have to be the servers DevHub reads.

There is no handshake between the two halves. `scripts/build_reh.py` names
tarballs and writes a statement beside each; `remoteServer.ts` looks for those
names, parses that statement and refuses whatever does not match the app. If
the two disagree by one character the symptom is a remote window refused with
"no remote extension host for linux-x64" by a DevHub that has one. So the names,
the statement and the bundle check are pinned here, and the names are compared
with the TypeScript that reads them.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from build_reh import (
	BUILT_IN_COPILOT_SDK,
	COPILOT_KEPT,
	DEFAULT_OUT_DIR,
	GULP_TARGETS,
	REPO_ROOT,
	TARGETS,
	bundle_problems,
	copilot_sdk_staging,
	docker_platform,
	gulp_task,
	musl_runtime_script,
	prune_stale,
	remote_modules_image,
	remote_modules_script,
	remove_copilot,
	stage_builtin_copilot_sdk,
	staging_dir,
	statement_name,
	tarball_name,
	top_level_dir,
	verify_image,
	write_statement,
)
from product_metadata import PRODUCT_OVERRIDES

REMOTE_SERVER_TS = REPO_ROOT / "apps" / "desktop" / "src" / "main" / "runtime" / "remoteServer.ts"
APP_CONTROLLER_TS = REPO_ROOT / "apps" / "desktop" / "src" / "main" / "shell" / "appController.ts"

# A hash of the right shape that is obviously not a real one.
COMMIT = "0" * 32 + "abcdef01"
IDENTITY = "0123456789ab"


class Targets(unittest.TestCase):
	def test_are_the_four_the_app_detects(self) -> None:
		# `REH_TARGETS` in remoteServer.ts is what a machine's platform is
		# mapped onto; a target built here and missing there is a server no
		# machine is ever given, and the reverse is a refusal at runtime.
		source = REMOTE_SERVER_TS.read_text()
		block = re.search(r"export const REH_TARGETS = \[(.*?)\] as const;", source, re.S)
		assert block is not None
		self.assertEqual(tuple(re.findall(r'"([^"]+)"', block.group(1))), TARGETS)

	def test_map_onto_vs_codes_own_gulp_targets(self) -> None:
		# `linux-alpine` is upstream's legacy name for the x64 musl server; the
		# other three are spelled the way DevHub spells them.
		self.assertEqual(gulp_task("alpine-x64"), "vscode-reh-linux-alpine-min-ci")
		self.assertEqual(gulp_task("alpine-arm64"), "vscode-reh-alpine-arm64-min-ci")
		self.assertEqual(gulp_task("linux-arm64"), "vscode-reh-linux-arm64-min-ci")
		self.assertEqual(staging_dir("alpine-x64").name, "vscode-reh-linux-alpine")

	def test_every_gulp_target_exists_upstream(self) -> None:
		gulpfile = REPO_ROOT / "vscode" / "build" / "gulpfile.reh.ts"
		if not gulpfile.is_file():
			self.skipTest("the vscode submodule is not checked out")
		text = gulpfile.read_text()
		for platform, arch in GULP_TARGETS.values():
			with self.subTest(target=f"{platform}-{arch}"):
				self.assertIn(f"{{ platform: '{platform}', arch: '{arch}' }}", text)

	def test_native_modules_are_built_for_the_targets_libc(self) -> None:
		self.assertEqual(remote_modules_image("alpine-arm64", "24.18.1"), "node:24.18.1-alpine")
		self.assertEqual(remote_modules_image("linux-x64", "24.18.1"), "node:24.18.1-bullseye")
		self.assertIn("apk add", remote_modules_script("alpine-x64"))
		self.assertIn("apt-get", remote_modules_script("linux-arm64"))
		for target in TARGETS:
			self.assertIn("npm ci", remote_modules_script(target))
		self.assertEqual(docker_platform("alpine-arm64"), "linux/arm64")
		self.assertEqual(docker_platform("linux-x64"), "linux/amd64")

	def test_a_musl_server_carries_the_cpp_runtime_alpine_lacks(self) -> None:
		# A stock Alpine has no libstdc++, and an Alpine with no network cannot
		# `apk add` it: the server's own node has to find it beside itself.
		script = musl_runtime_script()
		self.assertIn("libstdc++.so.6", script)
		self.assertIn("libgcc_s.so.1", script)
		self.assertIn("--set-rpath '$ORIGIN/lib' node", script)

	def test_are_started_on_a_machine_without_node(self) -> None:
		# The verification image is not the build image: a server that only
		# starts where Node is installed is not the server a far machine gets.
		for target in TARGETS:
			self.assertNotIn("node", verify_image(target))


class Names(unittest.TestCase):
	"""The names remoteServer.ts looks for, compared with the ones written."""

	def setUp(self) -> None:
		self.source = REMOTE_SERVER_TS.read_text()

	def test_tarball_statement_and_directory(self) -> None:
		self.assertEqual(tarball_name("alpine-x64"), "devhub-reh-alpine-x64.tar.gz")
		self.assertEqual(statement_name("alpine-x64"), "devhub-reh-alpine-x64.json")
		self.assertEqual(top_level_dir("alpine-x64"), "devhub-reh-alpine-x64")
		self.assertIn("return `devhub-reh-${target}.tar.gz`;", self.source)
		self.assertIn("return `devhub-reh-${target}.json`;", self.source)
		self.assertIn("return `devhub-reh-${target}`;", self.source)

	def test_every_target_has_its_own_tarball(self) -> None:
		self.assertEqual(len({tarball_name(t) for t in TARGETS}), len(TARGETS))

	def test_a_source_run_reads_where_the_build_writes(self) -> None:
		self.assertEqual(DEFAULT_OUT_DIR, REPO_ROOT / "dist" / "reh")
		self.assertIn('join(APP_ROOT, "..", "..", "dist", "reh")', APP_CONTROLLER_TS.read_text())

	def test_nothing_is_downloaded_any_more(self) -> None:
		# The servers travel inside DevHub. A template left in product.json
		# would be a second answer to "where does the server come from".
		self.assertNotIn("serverDownloadUrlTemplate", PRODUCT_OVERRIDES)

	def test_states_the_launcher_script_name(self) -> None:
		self.assertEqual(PRODUCT_OVERRIDES["serverApplicationName"], "devhub-server")

	def test_states_where_the_remote_keeps_it(self) -> None:
		self.assertEqual(PRODUCT_OVERRIDES["serverDataFolderName"], ".devhub-server")


class Bundle(unittest.TestCase):
	"""A directory of servers, as build_reh.py leaves it and packaging checks it."""

	def setUp(self) -> None:
		self.directory = Path(tempfile.mkdtemp(prefix="reh-bundle-"))
		self.addCleanup(lambda: shutil.rmtree(self.directory, ignore_errors=True))

	def server(self, target: str, identity: str = IDENTITY) -> None:
		(self.directory / tarball_name(target)).write_bytes(f"{target} {identity}".encode())
		write_statement(self.directory, target, COMMIT, identity)

	def test_statement_says_what_the_app_checks(self) -> None:
		self.server("alpine-arm64")
		said = json.loads((self.directory / statement_name("alpine-arm64")).read_text())
		self.assertEqual(
			said,
			{
				"target": "alpine-arm64",
				"commit": COMMIT,
				"identity": IDENTITY,
				"file": "devhub-reh-alpine-arm64.tar.gz",
				"sha256": hashlib.sha256(b"alpine-arm64 " + IDENTITY.encode()).hexdigest(),
				"topLevelDirectory": "devhub-reh-alpine-arm64",
			},
		)
		# And those are the fields remoteServer.ts refuses a statement without.
		for field in said:
			self.assertIn(f'"{field}"', REMOTE_SERVER_TS.read_text())

	def test_four_current_servers_are_a_bundle(self) -> None:
		for target in TARGETS:
			self.server(target)
		self.assertEqual(bundle_problems(self.directory, COMMIT, IDENTITY), [])

	def test_names_every_missing_server_and_how_to_build_it(self) -> None:
		self.server("linux-x64")
		problems = bundle_problems(self.directory, COMMIT, IDENTITY)
		self.assertEqual(len(problems), 3)
		self.assertTrue(any("scripts/build_reh.py alpine-arm64" in p for p in problems))

	def test_refuses_a_server_built_from_other_patches(self) -> None:
		for target in TARGETS:
			self.server(target)
		self.server("linux-arm64", identity="ffffffffffff")
		(problem,) = bundle_problems(self.directory, COMMIT, IDENTITY)
		self.assertIn("linux-arm64", problem)
		self.assertIn("ffffffffffff", problem)

	def test_refuses_a_tarball_its_statement_did_not_hash(self) -> None:
		for target in TARGETS:
			self.server(target)
		(self.directory / tarball_name("alpine-x64")).write_bytes(b"something else")
		(problem,) = bundle_problems(self.directory, COMMIT, IDENTITY)
		self.assertIn("hashes to", problem)

	def test_a_new_identity_takes_the_old_servers_away(self) -> None:
		self.server("linux-x64", identity="aaaaaaaaaaaa")
		self.server("alpine-x64", identity=IDENTITY)
		self.assertEqual(prune_stale(self.directory, IDENTITY), ["linux-x64"])
		self.assertFalse((self.directory / tarball_name("linux-x64")).exists())
		self.assertTrue((self.directory / tarball_name("alpine-x64")).exists())


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

		remove_copilot(self.staging, "linux-x64")

		self.assertFalse(extension.parent.parent.exists())
		self.assertFalse(runtime.parent.parent.exists())
		self.assertTrue(other.exists())

	def test_keeps_what_startup_reads_versions_from(self) -> None:
		self.write("extensions/copilot/dist/extension.js")
		kept = [self.write(f"{package}/package.json") for package in COPILOT_KEPT]

		remove_copilot(self.staging, "linux-x64")

		for path in kept:
			self.assertTrue(path.exists(), path)

	def test_refuses_to_find_nothing(self) -> None:
		# A tree with no Copilot in it means the build changed under us, and a
		# quietly smaller server is the kind of difference nobody traces back.
		self.write("extensions/git/dist/main.js")
		with self.assertRaises(SystemExit):
			remove_copilot(self.staging, "linux-x64")


class StageBuiltInCopilotSdk(unittest.TestCase):
	"""The invariant the last step of every REH package task asserts on.

	`prepareCopilotRipgrepShimTaskREH` walks into the server tree's copy of the
	built-in Copilot extension and throws when the SDK is not under it. The tree
	is copied out of `.build`, so `.build` is where the build has to be right,
	and it is the same requirement whatever the target — which is the half that
	broke: linux-x64 had it and linux-arm64 did not.
	"""

	def setUp(self) -> None:
		self.vscode = Path(tempfile.mkdtemp())
		self.addCleanup(lambda: shutil.rmtree(self.vscode, ignore_errors=True))
		self.staged, self.installed = copilot_sdk_staging(self.vscode)

	def materialize(self, sdk: Path) -> Path:
		index = sdk / "index.d.ts"
		index.parent.mkdir(parents=True, exist_ok=True)
		index.write_text("export {};\n")
		return index

	def test_same_paths_for_every_target(self) -> None:
		# Nothing about the SDK's place in the tree is per-platform: the
		# extension is built once and the shim step looks in one place. A
		# target-dependent answer here would be the bug, not the fix.
		self.assertEqual(self.staged, self.vscode / ".build" / BUILT_IN_COPILOT_SDK)
		self.assertEqual(self.installed, self.vscode / BUILT_IN_COPILOT_SDK)

	def test_fills_in_what_the_compile_did_not_copy(self) -> None:
		self.materialize(self.installed)

		stage_builtin_copilot_sdk(self.vscode)

		self.assertTrue((self.staged / "index.d.ts").is_file())

	def test_leaves_a_compile_that_did_its_job_alone(self) -> None:
		self.materialize(self.staged)
		self.materialize(self.installed)
		(self.staged / "index.d.ts").write_text("// from the compile\n")

		stage_builtin_copilot_sdk(self.vscode)

		self.assertEqual((self.staged / "index.d.ts").read_text(), "// from the compile\n")

	def test_refills_the_empty_shell_the_compile_left(self) -> None:
		# What linux-arm64 actually had (nightly 34703272262): `gulp.dest`
		# recreates the directory entries its source glob yielded, so an SDK
		# whose files were all filtered out reaches `.build` as a directory
		# with nothing in it. `is_dir()` says yes and the REH copy still
		# carries no `sdk` into the server tree.
		self.staged.mkdir(parents=True)
		self.materialize(self.installed)

		stage_builtin_copilot_sdk(self.vscode)

		self.assertTrue((self.staged / "index.d.ts").is_file())

	def test_materialises_an_sdk_npm_left_as_a_symlink(self) -> None:
		# The other shape that answers `is_dir()` and carries nothing: npm's
		# postinstall points `sdk` at the @github/copilot-<os>-<arch> package
		# instead of copying it, and a glob that does not follow symlinks walks
		# straight past. Packaging needs real files, so staging reads through.
		runtime = self.vscode / "node_modules" / "@github" / "copilot-linux-arm64" / "sdk"
		self.materialize(runtime)
		self.installed.parent.mkdir(parents=True, exist_ok=True)
		self.installed.symlink_to(runtime, target_is_directory=True)

		stage_builtin_copilot_sdk(self.vscode)

		self.assertFalse(self.staged.is_symlink())
		self.assertTrue((self.staged / "index.d.ts").is_file())
		self.assertFalse((self.staged / "index.d.ts").is_symlink())

	def test_stops_when_there_is_nothing_to_stage(self) -> None:
		# Building on would spend twenty minutes to reach an error about the
		# output tree that says nothing about the submodule that is short.
		with self.assertRaises(SystemExit) as caught:
			stage_builtin_copilot_sdk(self.vscode)
		self.assertIn(str(self.installed), str(caught.exception))


if __name__ == "__main__":
	unittest.main()
