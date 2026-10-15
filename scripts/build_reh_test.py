#!/usr/bin/env python3
"""The servers DevHub carries have to be the servers DevHub reads, built the
way VS Code builds its own.

There is no handshake between the two halves. `scripts/build_reh.py` names
tarballs and writes a statement beside each; `remoteServer.ts` looks for those
names, parses that statement and refuses whatever does not match the app. If
the two disagree by one character the symptom is a remote window refused with
"no remote extension host for linux-x64" by a DevHub that has one. So the names,
the statement and the bundle check are pinned here, and the names are compared
with the TypeScript that reads them.

The build itself runs in Docker, which these tests do not start. What they pin
is what is handed to Docker — the commands, the images, the cache keys, the
order of the steps — and the in-container script's own logic, run here under
`sh` against a fake tree.

    cd scripts && python3 -m unittest build_reh_test
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build_reh
from build_reh import (
	ARCHES,
	BUILDER_PLATFORM,
	COPILOT_KEPT,
	DEFAULT_OUT_DIR,
	GULP_TARGETS,
	IN_CONTAINER_SCRIPT,
	POST_STEPS,
	REPO_ROOT,
	TARGETS,
	VERIFY_GLIBC_SCRIPT,
	VSCODE_DIR,
	builder_dockerfile,
	builder_tag,
	bundle_problems,
	cached_server_problems,
	container_argv,
	docker_platform,
	drop_glibc_msal_runtime,
	foreign_binaries,
	glibc_verify_env,
	gulp_output_name,
	gulp_task,
	musl_dockerfile,
	musl_image,
	musl_runtime_script,
	musl_tag,
	prune_cache,
	prune_stale,
	reh_cache_root,
	remove_copilot,
	restore_cached_server,
	retry_command,
	source_key,
	statement_name,
	store_cached_server,
	tarball_name,
	targets_by_arch,
	top_level_dir,
	verify_image,
	windows_binaries,
	work_volume,
	write_statement,
)
from product_metadata import PRODUCT_OVERRIDES

REMOTE_SERVER_TS = REPO_ROOT / "apps" / "desktop" / "src" / "main" / "runtime" / "remoteServer.ts"
APP_CONTROLLER_TS = REPO_ROOT / "apps" / "desktop" / "src" / "main" / "shell" / "appController.ts"
APPLY_PATCHES = REPO_ROOT / "scripts" / "apply-vscode-patches.sh"
NIGHTLY = REPO_ROOT / ".github" / "workflows" / "nightly.yml"

# A hash of the right shape that is obviously not a real one.
COMMIT = "0" * 32 + "abcdef01"
IDENTITY = "0123456789ab"


def in_container_script() -> str:
	return IN_CONTAINER_SCRIPT.read_text()


def function_body(script: str, name: str) -> str:
	match = re.search(rf"^{name}\(\) \{{\n(.*?)^\}}\n", script, re.S | re.M)
	assert match is not None, name
	return match.group(1)


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
		self.assertEqual(gulp_task("linux-x64"), "vscode-reh-linux-x64-min-ci")
		self.assertEqual(gulp_output_name("alpine-x64"), "vscode-reh-linux-alpine")

	def test_every_gulp_target_exists_upstream(self) -> None:
		gulpfile = VSCODE_DIR / "build" / "gulpfile.reh.ts"
		if not gulpfile.is_file():
			self.skipTest("the vscode submodule is not checked out")
		text = gulpfile.read_text()
		for platform, arch in GULP_TARGETS.values():
			with self.subTest(target=f"{platform}-{arch}"):
				self.assertIn(f"{{ platform: '{platform}', arch: '{arch}' }}", text)

	def test_a_musl_server_carries_the_cpp_runtime_alpine_lacks(self) -> None:
		# A stock Alpine has no libstdc++, and an Alpine with no network cannot
		# `apk add` it: the server's own node has to find it beside itself.
		script = musl_runtime_script()
		self.assertIn("libstdc++.so.6", script)
		self.assertIn("libgcc_s.so.1", script)
		self.assertIn("--set-rpath '$ORIGIN/lib' node", script)
		# patchelf is baked into the musl image; no network at bundling.
		self.assertNotIn("apk add", script)
		self.assertIn("patchelf", musl_dockerfile("24.18.1"))

	def test_are_started_on_a_machine_without_node(self) -> None:
		# The verification image is not the build image: a server that only
		# starts where Node is installed is not the server a far machine gets.
		for target in TARGETS:
			self.assertNotIn("node", verify_image(target))
		# Debian 10's glibc is 2.28: the glibc server is started where the floor is.
		self.assertEqual(verify_image("linux-arm64"), "debian:buster-slim")
		self.assertEqual(verify_image("alpine-x64"), "alpine:3")


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
	"""Which parts of the built tree the deletion takes, and which it leaves."""

	def setUp(self) -> None:
		self.staging = Path(tempfile.mkdtemp(prefix="reh-test-"))
		self.addCleanup(lambda: shutil.rmtree(self.staging, ignore_errors=True))

	def write(self, relative: str, size: int = 1024) -> Path:
		path = self.staging / relative
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_bytes(b"\0" * size)
		return path

	def test_takes_the_extension_and_the_platform_runtime(self) -> None:
		extension = self.write("extensions/copilot/dist/extension.js")
		runtime = self.write("node_modules/@github/copilot-linux-x64/prebuilds/runtime.node")
		other = self.write("extensions/git/dist/main.js")

		with mock.patch("builtins.print"):
			remove_copilot(self.staging, "linux-x64")

		self.assertFalse(extension.parent.parent.exists())
		self.assertFalse(runtime.parent.parent.exists())
		self.assertTrue(other.exists())

	def test_keeps_what_startup_reads_versions_from(self) -> None:
		self.write("extensions/copilot/dist/extension.js")
		kept = [self.write(f"{package}/package.json") for package in COPILOT_KEPT]

		with mock.patch("builtins.print"):
			remove_copilot(self.staging, "linux-x64")

		for path in kept:
			self.assertTrue(path.exists(), path)

	def test_refuses_to_find_nothing(self) -> None:
		# A tree with no Copilot in it means the build changed under us, and a
		# quietly smaller server is the kind of difference nobody traces back.
		self.write("extensions/git/dist/main.js")
		with self.assertRaises(SystemExit):
			remove_copilot(self.staging, "linux-x64")


class Plan(unittest.TestCase):
	"""One tree per architecture serves both of its servers."""

	def test_groups_by_architecture_glibc_first(self) -> None:
		self.assertEqual(
			targets_by_arch(list(reversed(TARGETS))),
			[("x64", ["linux-x64", "alpine-x64"]), ("arm64", ["linux-arm64", "alpine-arm64"])],
		)
		self.assertEqual(targets_by_arch(["alpine-arm64"]), [("arm64", ["alpine-arm64"])])
		self.assertEqual(ARCHES, ("x64", "arm64"))

	def test_one_volume_per_architecture(self) -> None:
		with mock.patch.dict(os.environ, {}, clear=False):
			os.environ.pop("DEVHUB_REH_WORK_VOLUME", None)
			self.assertEqual(work_volume("x64"), "devhub-reh-work-x64")
			self.assertEqual(work_volume("arm64"), "devhub-reh-work-arm64")
		with mock.patch.dict(os.environ, {"DEVHUB_REH_WORK_VOLUME": "ci-reh"}):
			self.assertEqual(work_volume("arm64"), "ci-reh-arm64")


class Images(unittest.TestCase):
	def test_builder_is_upstreams_linux_agent_on_amd64(self) -> None:
		df = builder_dockerfile("22.21.1")
		self.assertTrue(df.startswith("FROM ubuntu:22.04\n"))
		self.assertEqual(BUILDER_PLATFORM, "linux/amd64")
		self.assertIn("https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz", df)
		self.assertIn("sha256sum -c SHASUMS256.txt", df)
		self.assertIn("node --version | grep -qx v22.21.1", df)
		# setup-env.sh pipes Chromium's clang updater into `python -`.
		self.assertIn("python-is-python3", df)
		for package in ("build-essential", "pkg-config", "libkrb5-dev", "libxkbfile-dev", "libx11-dev", "git"):
			self.assertIn(package, df)
		# no sysroot of DevHub's own: setup-env.sh downloads upstream's
		self.assertNotIn("sysroot", df)

	def test_tags_follow_the_dockerfile(self) -> None:
		self.assertRegex(builder_tag("22.21.1"), r"^devhub-reh-builder:[0-9a-f]{12}$")
		self.assertNotEqual(builder_tag("22.21.1"), builder_tag("22.21.2"))
		self.assertRegex(musl_tag("alpine-arm64", "24.18.1"), r"^devhub-reh-musl:arm64-[0-9a-f]{12}$")
		self.assertNotEqual(musl_tag("alpine-x64", "24.18.1"), musl_tag("alpine-arm64", "24.18.1"))
		self.assertNotEqual(musl_tag("alpine-x64", "24.18.1"), musl_tag("alpine-x64", "24.18.2"))

	def test_musl_image_is_node_alpine_with_compilers(self) -> None:
		self.assertEqual(musl_image("24.18.1"), "node:24.18.1-alpine")
		df = musl_dockerfile("24.18.1")
		self.assertTrue(df.startswith("FROM node:24.18.1-alpine\n"))
		self.assertIn("apk add --no-cache python3 make g++ krb5-dev linux-headers patchelf", df)
		self.assertEqual(docker_platform("alpine-arm64"), "linux/arm64")
		self.assertEqual(docker_platform("alpine-x64"), "linux/amd64")


class Commands(unittest.TestCase):
	"""What each step hands to `docker run`."""

	def argv(self, subcommand: str, **kwargs) -> list[str]:
		return container_argv(
			"img:1", "linux/amd64", "bash", subcommand, {"B": "2", "A": "1"},
			volume="devhub-reh-work-x64", xfer=Path("/x"), **kwargs,
		)

	def test_mounts_the_volume_scripts_patches_and_xfer(self) -> None:
		argv = self.argv("prepare")
		self.assertEqual(argv[:5], ["docker", "run", "--rm", "--platform", "linux/amd64"])
		joined = " ".join(argv)
		self.assertIn("-v devhub-reh-work-x64:/build", joined)
		self.assertIn(f"-v {REPO_ROOT / 'scripts'}:/devhub/scripts:ro", joined)
		self.assertIn(f"-v {REPO_ROOT / 'patches'}:/devhub/patches:ro", joined)
		self.assertIn("-v /x:/xfer", joined)
		self.assertNotIn("/server", joined)
		self.assertEqual(argv[-4:], ["img:1", "bash", "/devhub/scripts/reh_in_container.sh", "prepare"])
		# never the developer's vscode/ checkout
		self.assertNotIn(str(VSCODE_DIR), joined)

	def test_environment_is_explicit_and_the_token_goes_by_name(self) -> None:
		argv = self.argv("package")
		self.assertIn("GITHUB_TOKEN", argv)
		with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "ghp_secret"}):
			self.assertNotIn("ghp_secret", " ".join(self.argv("package")))
		env = [argv[i + 1] for i, a in enumerate(argv) if a == "-e"]
		self.assertEqual(env, ["GITHUB_TOKEN", "A=1", "B=2"])

	def test_glibc_check_mounts_the_server_read_only(self) -> None:
		argv = self.argv("verify-glibc", server=Path("/s/tree"))
		self.assertIn("/s/tree:/server:ro", argv)
		env = glibc_verify_env("linux-arm64")
		self.assertEqual(env["EXPECTED_GLIBC_VERSION"], "2.28")
		self.assertEqual(env["EXPECTED_GLIBCXX_VERSION"], "3.4.25")
		self.assertEqual(env["ARCH"], "arm64")

	def recorded(self, target: str) -> list[list[str]]:
		calls: list[list[str]] = []
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		with mock.patch("build_reh.run_step", calls.append), \
			mock.patch("build_reh.ensure_builder", return_value="builder:1"), \
			mock.patch("build_reh.ensure_musl_image", return_value="musl:1"), \
			mock.patch("build_reh.remote_node_version", return_value="24.18.1"), \
			mock.patch("build_reh.cache_base", return_value=root):
			if build_reh.libc_of(target) == "musl":
				build_reh.install_musl_remote(target)
			build_reh.package_target(target, COMMIT)
		return calls

	def test_musl_targets_install_remote_in_their_own_platform(self) -> None:
		musl, package = self.recorded("alpine-arm64")
		self.assertEqual(musl[musl.index("--platform") + 1], "linux/arm64")
		self.assertIn("devhub-reh-work-arm64:/build", musl)
		self.assertEqual(musl[-4:], ["musl:1", "sh", "/devhub/scripts/reh_in_container.sh", "musl-remote"])
		for pair in ("GULP_PLATFORM=alpine", "GULP_ARCH=arm64", "NODE_VERSION=24.18.1", "MUSL_IMAGE=musl:1"):
			self.assertIn(pair, musl)
		# packaging is the builder's, always amd64, in the same tree
		self.assertEqual(package[package.index("--platform") + 1], "linux/amd64")
		self.assertIn("devhub-reh-work-arm64:/build", package)
		self.assertIn("LIBC=musl", package)
		self.assertEqual(package[-1], "package")

	def test_alpine_x64_is_upstreams_linux_alpine(self) -> None:
		musl, package = self.recorded("alpine-x64")
		self.assertIn("GULP_PLATFORM=linux", package)
		self.assertIn("GULP_ARCH=alpine", package)
		self.assertIn("ARCH=x64", package)
		self.assertIn("devhub-reh-work-x64:/build", musl)

	def test_glibc_targets_package_without_a_musl_step(self) -> None:
		(package,) = self.recorded("linux-arm64")
		self.assertIn("LIBC=glibc", package)
		self.assertIn("ARCH=arm64", package)
		self.assertIn(f"COMMIT={COMMIT}", package)


class Native(unittest.TestCase):
	"""`--native`: the same steps on a Linux x64 host, without Docker."""

	def setUp(self) -> None:
		patcher = mock.patch("build_reh.NATIVE", True)
		patcher.start()
		self.addCleanup(patcher.stop)
		self.root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, self.root, True)

	def recorded(self, run) -> list[tuple[list[str], dict[str, str]]]:
		calls: list[tuple[list[str], dict[str, str]]] = []
		with mock.patch("build_reh.run_step", lambda argv, env=None: calls.append((argv, env))), \
			mock.patch("build_reh.ensure_builder", side_effect=AssertionError("no Docker natively")), \
			mock.patch("build_reh.build_node_version", return_value="24.18.0"), \
			mock.patch("build_reh.cache_base", return_value=self.root), \
			mock.patch.dict(os.environ, {"GITHUB_TOKEN": "ghp_x"}):
			run()
		return calls

	def test_runs_the_same_script_on_the_host(self) -> None:
		((argv, env),) = self.recorded(lambda: build_reh.package_target("linux-x64", COMMIT))
		self.assertEqual(argv, ["bash", str(IN_CONTAINER_SCRIPT), "package"])
		self.assertEqual(env["DEVHUB_REH_BUILD"], str(self.root / "reh-native" / "x64"))
		self.assertEqual(env["DEVHUB_REH_XFER"], str(self.root / "reh-xfer" / "x64"))
		self.assertEqual(env["DEVHUB_REH_DEVHUB"], str(REPO_ROOT))
		for key, value in (("LIBC", "glibc"), ("GULP_PLATFORM", "linux"), ("GULP_ARCH", "x64"), ("COMMIT", COMMIT)):
			self.assertEqual(env[key], value)
		# the host's environment goes through: the token, the PATH with its Node
		self.assertEqual(env["GITHUB_TOKEN"], "ghp_x")
		self.assertNotIn("docker", " ".join(argv))

	def test_glibc_check_reads_the_staged_server(self) -> None:
		calls = self.recorded(lambda: build_reh.verify_glibc_floor(Path("/s/tree"), "linux-x64"))
		((argv, env),) = calls
		self.assertEqual(argv[-1], "verify-glibc")
		self.assertEqual(env["SERVER"], "/s/tree")
		self.assertEqual(env["EXPECTED_GLIBC_VERSION"], "2.28")

	def test_the_builder_stamp_names_the_host_and_its_node(self) -> None:
		self.assertEqual(build_reh.native_builder("24.18.0").rsplit("-", 1)[-1], "node24.18.0")
		self.assertTrue(build_reh.native_builder("24.18.0").startswith("native-"))

	def test_only_linux_x64_and_only_on_linux_x64(self) -> None:
		with mock.patch("build_reh.native_host", return_value=True):
			self.assertIsNone(build_reh.native_refusal(["linux-x64"]))
			refusal = build_reh.native_refusal(["linux-x64", "alpine-x64", "linux-arm64"])
			self.assertIn("alpine-x64, linux-arm64", refusal)
			self.assertIn("Docker", refusal)
		with mock.patch("build_reh.native_host", return_value=False):
			self.assertIn("Linux x86-64", build_reh.native_refusal(["linux-x64"]))

	def test_names_a_wrong_node(self) -> None:
		with mock.patch("build_reh.build_node_version", return_value="0.0.1"):
			problems = build_reh.native_problems()
		self.assertTrue(any("v0.0.1" in p and ".nvmrc" in p for p in problems), problems)

	def main_with(self, argv: list[str], docker: bool, host: bool) -> tuple[int, list[tuple], str]:
		calls: list[tuple] = []
		with mock.patch("sys.argv", ["build_reh.py", *argv, "--no-cache", "--out-dir", str(self.root)]), \
			mock.patch("build_reh.docker_available", return_value=docker), \
			mock.patch("build_reh.native_host", return_value=host), \
			mock.patch("build_reh.native_problems", return_value=[]), \
			mock.patch("build_reh.vscode_commit", return_value=COMMIT), \
			mock.patch("build_reh.reh_identity", return_value=IDENTITY), \
			mock.patch("build_reh.require_commit"), \
			mock.patch("build_reh.warn_about_docker"), \
			mock.patch("build_reh.packaged_metadata", return_value={}), \
			mock.patch("build_reh.prepare_tree", lambda arch, *a: calls.append(("prepare", arch, build_reh.NATIVE)) or 0.0), \
			mock.patch("build_reh.build_target", lambda t, *a: calls.append(("build", t, build_reh.NATIVE))), \
			mock.patch("builtins.print") as said:
			try:
				code = build_reh.main()
			except SystemExit as stop:
				code = stop.code
		text = " ".join(str(c.args[0]) for c in said.call_args_list if c.args)
		return code, calls, text

	def test_main_builds_natively_when_docker_is_missing_on_linux_x64(self) -> None:
		code, calls, text = self.main_with(["linux-x64"], docker=False, host=True)
		self.assertEqual(code, 0)
		self.assertEqual(calls, [("prepare", "x64", True), ("build", "linux-x64", True)])
		self.assertIn("--native", text)

	def test_main_uses_docker_when_it_is_there(self) -> None:
		code, calls, _ = self.main_with(["linux-x64"], docker=True, host=True)
		self.assertEqual(calls, [("prepare", "x64", False), ("build", "linux-x64", False)])

	def test_main_refuses_musl_natively(self) -> None:
		code, calls, _ = self.main_with(["alpine-x64", "--native"], docker=False, host=True)
		self.assertIn("alpine-x64", str(code))
		self.assertEqual(calls, [])

	def test_a_server_that_says_it_listens_is_started(self) -> None:
		launcher = self.root / "server"
		launcher.write_text("#!/bin/sh\necho starting\necho 'Extension host agent listening on 127.0.0.1:4711'\nexec sleep 60\n")
		launcher.chmod(0o755)
		self.assertIn("listening on", build_reh.server_listens(launcher, build_reh.native_start_env(), timeout=30))
		launcher.write_text("#!/bin/sh\necho 'Error: cannot find module'\nexit 1\n")
		self.assertIsNone(build_reh.server_listens(launcher, build_reh.native_start_env(), timeout=30))

	def test_start_environment_hands_the_server_no_node(self) -> None:
		env = build_reh.native_start_env()
		self.assertEqual(env["PATH"], "/usr/bin:/bin")
		self.assertNotIn("NODE_OPTIONS", env)


class SourceKey(unittest.TestCase):
	METADATA = {"nameShort": "DevHub", "commit": COMMIT, "date": "2026-01-01T00:00:00Z", "hostCommit": "abc"}

	def test_stable_and_sensitive_to_what_the_tree_is_built_from(self) -> None:
		base = source_key(IDENTITY, self.METADATA)
		self.assertEqual(base, source_key(IDENTITY, dict(self.METADATA)))
		self.assertNotEqual(base, source_key("ffffffffffff", self.METADATA))
		self.assertNotEqual(base, source_key(IDENTITY, {**self.METADATA, "nameShort": "X"}))
		self.assertNotEqual(base, source_key(IDENTITY, self.METADATA, revision=99))

	def test_a_new_date_or_devhub_commit_does_not_recompile(self) -> None:
		base = source_key(IDENTITY, self.METADATA)
		self.assertEqual(base, source_key(IDENTITY, {**self.METADATA, "date": "2027-01-01T00:00:00Z"}))
		self.assertEqual(base, source_key(IDENTITY, {**self.METADATA, "hostCommit": "def"}))

	def test_environment_never_reaches_the_key(self) -> None:
		base = source_key(IDENTITY, self.METADATA)
		with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "ghp_secret"}):
			self.assertEqual(base, source_key(IDENTITY, self.METADATA))


class StepOrder(unittest.TestCase):
	def test_post_steps(self) -> None:
		self.assertEqual(
			POST_STEPS,
			(
				"remove_copilot",
				"drop_glibc_msal_runtime",
				"bundle_musl_runtime",
				"refuse_foreign_binaries",
				"verify_glibc_floor",
				"verify_server_starts",
			),
		)

	def run_target(self, target: str) -> list[str]:
		calls: list[str] = []
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		staging = root / "xfer" / target / gulp_output_name(target)
		staging.mkdir(parents=True)
		(staging / "file").write_text("x")
		out = root / "out"
		out.mkdir()

		def step(name):
			return lambda *a, **k: calls.append(name)

		patches = {name: step(name) for name in POST_STEPS}
		with mock.patch.multiple("build_reh", **patches), \
			mock.patch("build_reh.install_musl_remote", step("musl-remote")), \
			mock.patch("build_reh.package_target", lambda *a: calls.append("package") or root / "t.tar"), \
			mock.patch("build_reh.unpack_staging", lambda *a: calls.append("unpack") or staging), \
			mock.patch("build_reh.store_cached_server", step("cache")), \
			mock.patch("builtins.print"):
			build_reh.build_target(target, COMMIT, IDENTITY, out)
		self.assertTrue((out / tarball_name(target)).is_file())
		self.assertEqual(bundle_problems(out, COMMIT, IDENTITY, required=(target,)), [])
		self.assertFalse(staging.exists())
		return calls

	def test_musl(self) -> None:
		self.assertEqual(self.run_target("alpine-x64"), ["musl-remote", "package", "unpack", *POST_STEPS, "cache"])

	def test_glibc(self) -> None:
		self.assertEqual(self.run_target("linux-x64"), ["package", "unpack", *POST_STEPS, "cache"])

	def test_main_prepares_each_tree_before_its_targets(self) -> None:
		calls: list[tuple] = []
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		with mock.patch("sys.argv", ["build_reh.py", "alpine-arm64", "linux-x64", "--no-cache", "--out-dir", str(root)]), \
			mock.patch("build_reh.docker_available", return_value=True), \
			mock.patch("build_reh.vscode_commit", return_value=COMMIT), \
			mock.patch("build_reh.reh_identity", return_value=IDENTITY), \
			mock.patch("build_reh.require_commit"), \
			mock.patch("build_reh.warn_about_docker"), \
			mock.patch("build_reh.packaged_metadata", return_value={"commit": COMMIT}), \
			mock.patch("build_reh.prepare_tree", lambda arch, *a: calls.append(("prepare", arch)) or 0.0), \
			mock.patch("build_reh.build_target", lambda t, *a: calls.append(("build", t))), \
			mock.patch("builtins.print"):
			self.assertEqual(build_reh.main(), 0)
		self.assertEqual(calls, [("prepare", "x64"), ("build", "linux-x64"), ("prepare", "arm64"), ("build", "alpine-arm64")])

	def test_a_failed_tree_names_what_to_retry(self) -> None:
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)

		def fail(*a):
			raise subprocess.CalledProcessError(1, "docker")

		with mock.patch("sys.argv", ["build_reh.py", "linux-arm64", "--no-cache", "--out-dir", str(root)]), \
			mock.patch("build_reh.docker_available", return_value=True), \
			mock.patch("build_reh.vscode_commit", return_value=COMMIT), \
			mock.patch("build_reh.reh_identity", return_value=IDENTITY), \
			mock.patch("build_reh.require_commit"), \
			mock.patch("build_reh.warn_about_docker"), \
			mock.patch("build_reh.packaged_metadata", return_value={}), \
			mock.patch("build_reh.prepare_tree", fail), \
			mock.patch("builtins.print") as said:
			self.assertEqual(build_reh.main(), 1)
		text = " ".join(str(c.args[0]) for c in said.call_args_list if c.args)
		self.assertIn("scripts/build_reh.py linux-arm64", text)
		self.assertIn("devhub-reh-work-arm64", text)


class OldPathsAreGone(unittest.TestCase):
	"""Gulp on the host and the patch-ups after it are not coming back."""

	def test_no_host_gulp_or_patch_ups(self) -> None:
		for name in (
			"retarget_msal_runtime", "rebuild_native_extensions", "native_packages",
			"replace_native_packages", "install_remote_modules", "restore_remote_modules",
			"write_devhub_product_json", "gulp", "bundle_server_sources", "toolchain_node_bin",
			"stage_builtin_copilot_sdk", "fetch_musl_node", "modules_cache_key",
		):
			with self.subTest(name=name):
				self.assertFalse(hasattr(build_reh, name))
		source = Path(build_reh.__file__).read_text()
		self.assertNotIn("provision-vscode.sh", source)
		self.assertNotIn('"npm", "run", "gulp"', source)
		self.assertNotIn("--skip-provision", source)

	def test_the_nightly_does_not_provision_for_the_servers(self) -> None:
		text = NIGHTLY.read_text()
		job = text[text.index("\n  reh:\n"):]
		job = job[: job.index("\n  # ----", 1)]
		self.assertNotIn("provision-vscode.sh", job)
		self.assertNotIn("--skip-provision", job)
		self.assertNotIn("ubuntu-24.04-arm", job)
		self.assertIn("scripts/build_reh.py ${{ matrix.targets }}", job)


class InContainerScript(unittest.TestCase):
	"""scripts/reh_in_container.sh: upstream's steps, in upstream's order."""

	def setUp(self) -> None:
		self.script = in_container_script()

	def test_parses_as_posix_sh_and_bash(self) -> None:
		for shell in ("sh", "bash"):
			if not shutil.which(shell):
				continue
			with self.subTest(shell=shell):
				result = subprocess.run([shell, "-n", str(IN_CONTAINER_SCRIPT)], capture_output=True, text=True)
				self.assertEqual(result.returncode, 0, result.stderr)
		self.assertTrue(os.access(IN_CONTAINER_SCRIPT, os.X_OK))

	def test_prepare_follows_the_linux_pipeline(self) -> None:
		body = function_body(self.script, "prepare")
		order = [
			"tar -xf \"$X/vscode-src.tar\"",
			"git -C \"$V\" init -q",
			"apply-vscode-patches.sh\" --into \"$V\"",
			"product-overrides.json",
			"(cd build && npm_ci)",
			"export npm_config_arch=\"$ARCH\" VSCODE_ARCH=\"$ARCH\"",
			". ./build/azure-pipelines/linux/setup-env.sh",
			"node build/npm/preinstall.ts",
			"npm_ci\n\t\t)",
			"builtin_extensions",
			"node build/npm/electronTypes.ts",
			"core_ci_server",
			"VSCODE_QUALITY=stable npm run gulp compile-copilot-extension-build",
			"stage_copilot_sdk",
		]
		positions = [body.index(step) for step in order]
		self.assertEqual(positions, sorted(positions))
		for flag in ("ELECTRON_SKIP_BINARY_DOWNLOAD=1", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1", "ONNXRUNTIME_NODE_INSTALL=skip"):
			self.assertIn(flag, body)
		self.assertIn("BUILD_SOURCEVERSION=\"$COMMIT\"", body)
		self.assertIn("GIT_COMMITTER_DATE=\"$COMMIT_DATE\"", body)

	def test_core_ci_for_the_server_is_core_cis_own_tasks_minus_the_client(self) -> None:
		body = function_body(self.script, "core_ci_server")
		order = [
			"--series check-api-proposal-names copy-codicons",
			"compile-non-native-extensions-build compile-extension-media-build",
			"git log -1 --format=%cI HEAD > out-build/date",
			"node build/next/index.ts bundle --out out-vscode-reh-min --target server",
			"--minify --mangle-privates --nls",
			'--source-map-base-url "https://main.vscode-cdn.net/sourcemaps/$COMMIT/core"',
		]
		positions = [body.index(step) for step in order]
		self.assertEqual(positions, sorted(positions))
		# never the desktop bundle, which no server carries and which ran it out of memory
		self.assertNotIn("core-ci\n", body)
		self.assertNotIn("--target desktop", body)

	def test_core_ci_for_the_server_matches_upstreams_core_ci(self) -> None:
		gulpfile = VSCODE_DIR / "build" / "gulpfile.vscode.ts"
		if not gulpfile.is_file():
			self.skipTest("the vscode submodule is not checked out")
		text = gulpfile.read_text()
		core = text[text.index("task.define('core-ci'"):]
		core = core[: core.index(")));")]
		for piece in (
			"checkApiProposalNamesTask", "copyCodiconsTask", "compileNonNativeExtensionsBuildTask",
			"compileExtensionMediaBuildTask", "writeISODate('out-build')",
			"runEsbuildBundle('out-vscode-reh-min', true, true, 'server', `${sourceMappingURLBase}/core`)",
		):
			self.assertIn(piece, core)
		self.assertIn("const sourceMappingURLBase = `https://main.vscode-cdn.net/sourcemaps/${commit}`", text)
		esbuild = (VSCODE_DIR / "build" / "lib" / "esbuild.ts").read_text()
		for flag in ("'--minify'", "'--mangle-privates'", "'--nls'", "'--source-map-base-url'"):
			self.assertIn(flag, esbuild)

	def test_built_in_extensions_come_from_their_pinned_releases(self) -> None:
		body = function_body(self.script, "builtin_extensions")
		order = [
			'cp product.json "$S/product.json"',
			"delete product.extensionsGallery",
			'VSCODE_EXTENSION_TARGET="linux-$ARCH" node build/lib/builtInExtensions.ts',
			'mv "$S/product.json" product.json',
			"die ",
		]
		positions = [body.index(step) for step in order]
		self.assertEqual(positions, sorted(positions))

	def test_npm_ci_retries_five_times_as_upstream(self) -> None:
		body = function_body(self.script, "npm_ci")
		self.assertIn("npm ci", body)
		self.assertIn("-lt 5", body)

	def test_a_failed_npm_ci_shows_npms_own_error(self) -> None:
		if not shutil.which("sh"):
			self.skipTest("no sh")
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		bindir = root / "bin"
		bindir.mkdir()
		logs = root / "cache" / "_logs"
		(bindir / "npm").write_text(
			"#!/bin/sh\n"
			f"mkdir -p {logs}\n"
			f"printf '1 verbose noise\\n2 error gyp ERR! stack Error: 403 downloading headers\\n' > {logs}/2026-01-01T00_00_00_000Z-debug-0.log\n"
			"exit 1\n"
		)
		(bindir / "npm").chmod(0o755)
		result = self.lib(
			root, "npm_ci", PATH=f"{bindir}:/usr/bin:/bin", npm_config_cache=str(root / "cache"),
		)
		self.assertNotEqual(result.returncode, 0)
		self.assertIn("403 downloading headers", result.stdout)
		self.assertNotIn("verbose noise", result.stdout)
		self.assertEqual(result.stdout.count("npm ci failed (try"), 5)
		self.assertIn("failed 5 times", result.stderr)

	def test_setup_env_writes_into_a_home_of_the_trees_own(self) -> None:
		body = function_body(self.script, "prepare")
		self.assertLess(body.index('export HOME="$S/home"'), body.index(". ./build/azure-pipelines/linux/setup-env.sh"))
		for kept in ("npm_config_cache=", "npm_config_userconfig=", "GIT_CONFIG_GLOBAL="):
			self.assertIn(kept, body)

	def test_musl_remote_is_upstreams_alpine_container_install(self) -> None:
		body = function_body(self.script, "musl_remote")
		self.assertIn("npm i -g node-gyp-build && npm_ci", body)
		self.assertIn("@parcel/watcher-*", body)
		self.assertIn("$V/.build/node/v$NODE_VERSION/$GULP_PLATFORM-$GULP_ARCH", body)
		self.assertIn("use_remote musl", body)

	def test_package_runs_the_ci_task_and_tars_it_out(self) -> None:
		body = function_body(self.script, "package")
		self.assertIn("use_remote \"$LIBC\"", body)
		self.assertIn("npm run gulp \"$out-min-ci\"", body)
		self.assertIn("out=\"vscode-reh-$GULP_PLATFORM-$GULP_ARCH\"", body)
		self.assertIn("tar -C \"$B\" -cf", body)

	def test_glibc_check_is_upstreams_with_the_trees_sysroot(self) -> None:
		body = function_body(self.script, "verify_glibc")
		self.assertIn("./build/azure-pipelines/linux/verify-glibc-requirements.sh", body)
		self.assertIn("VSCODE_SYSROOT_DIR=\"$V/.build/sysroots/$SYSROOT_DIR_NAME\"", body)
		self.assertIn('SYSROOT_DIR_NAME="glibc-2.28-gcc-8.5.0"', self.script)

	def test_sysroot_dir_matches_setup_env(self) -> None:
		setup_env = VSCODE_DIR / "build" / "azure-pipelines" / "linux" / "setup-env.sh"
		if not setup_env.is_file():
			self.skipTest("the vscode submodule is not checked out")
		self.assertIn("VSCODE_REMOTE_SYSROOT_DIR=$PWD/.build/sysroots/glibc-2.28-gcc-8.5.0", setup_env.read_text())

	def lib(self, root: Path, code: str, **env: str) -> subprocess.CompletedProcess:
		full = {
			"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
			"DEVHUB_REH_LIB": "1",
			"DEVHUB_REH_BUILD": str(root),
			"DEVHUB_REH_XFER": str(root / "xfer"),
			**env,
		}
		return subprocess.run(
			["sh", "-c", f". {IN_CONTAINER_SCRIPT}; {code}"], env=full, capture_output=True, text=True
		)

	def test_remote_node_modules_swap_between_libcs(self) -> None:
		if not shutil.which("sh"):
			self.skipTest("no sh")
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		modules = root / "vscode" / "remote" / "node_modules"
		modules.mkdir(parents=True)
		(modules / "glibc").write_text("")
		(root / ".devhub").mkdir()

		result = self.lib(root, "use_remote musl")
		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertFalse(modules.exists())  # nothing installed for musl yet
		self.assertTrue((root / ".devhub" / "remote-glibc" / "glibc").is_file())
		self.assertEqual((root / ".devhub" / "remote.libc").read_text().strip(), "musl")

		modules.mkdir()
		(modules / "musl").write_text("")
		self.assertEqual(self.lib(root, "use_remote glibc").returncode, 0)
		self.assertTrue((modules / "glibc").is_file())
		self.assertTrue((root / ".devhub" / "remote-musl" / "musl").is_file())

		self.assertEqual(self.lib(root, "use_remote musl; use_remote musl").returncode, 0)
		self.assertTrue((modules / "musl").is_file())
		self.assertTrue((root / ".devhub" / "remote-glibc" / "glibc").is_file())

	def copilot_tree(self, root: Path, staged: bool) -> Path:
		if not shutil.which("node"):
			self.skipTest("no node")
		installed = root / "vscode" / "extensions" / "copilot" / "node_modules" / "@github" / "copilot"
		(installed / "sdk").mkdir(parents=True)
		(installed / "sdk" / "index.js").write_text("")
		(installed / "package.json").write_text('{"version": "1.0.73"}')
		target = root / "vscode" / ".build" / "extensions" / "copilot" / "node_modules" / "@github" / "copilot"
		if staged:
			(target / "sdk").mkdir(parents=True)  # the empty shell the compile leaves
		return target

	def test_copilot_sdk_is_staged_as_files_with_its_package_json(self) -> None:
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		staged = self.copilot_tree(root, staged=True)
		result = self.lib(root, "stage_copilot_sdk")
		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertTrue((staged / "sdk" / "index.js").is_file())
		self.assertIn("1.0.73", (staged / "package.json").read_text())
		# and a second run leaves a good staging alone
		self.assertEqual(self.lib(root, "stage_copilot_sdk").stdout, "")

	def test_copilot_sdk_without_a_version_stops_the_build(self) -> None:
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		self.copilot_tree(root, staged=False)
		installed = root / "vscode" / "extensions" / "copilot" / "node_modules" / "@github" / "copilot"
		(installed / "package.json").write_text("{}")
		result = self.lib(root, "stage_copilot_sdk")
		self.assertNotEqual(result.returncode, 0)
		self.assertIn("no package.json version", result.stderr)


class ApplyPatchesInto(unittest.TestCase):
	"""`apply-vscode-patches.sh --into` patches a copy, not the submodule."""

	def test_applies_every_patch_to_the_given_tree(self) -> None:
		if not (shutil.which("bash") and shutil.which("git")):
			self.skipTest("no bash or git")
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		(root / "scripts").mkdir()
		shutil.copy2(APPLY_PATCHES, root / "scripts" / APPLY_PATCHES.name)
		(root / "patches" / "vscode").mkdir(parents=True)
		(root / "patches" / "vscode" / "0001-x.patch").write_text(
			"--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-upstream\n+devhub\n"
		)
		tree = root / "copy"
		tree.mkdir()
		subprocess.run(["git", "init", "-q", str(tree)], check=True)
		(tree / "file.txt").write_text("upstream\n")
		result = subprocess.run(
			["bash", str(root / "scripts" / APPLY_PATCHES.name), "--into", str(tree)],
			capture_output=True, text=True,
		)
		self.assertEqual(result.returncode, 0, result.stderr)
		self.assertEqual((tree / "file.txt").read_text(), "devhub\n")
		self.assertFalse((root / "vscode").exists())

	def test_refuses_other_arguments(self) -> None:
		if not shutil.which("bash"):
			self.skipTest("no bash")
		result = subprocess.run(["bash", str(APPLY_PATCHES), "--into"], capture_output=True, text=True)
		self.assertEqual(result.returncode, 2)


class GlibcFloor(unittest.TestCase):
	def test_upstreams_check_fails_above_2_28(self) -> None:
		# VS Code's script, run here with a stand-in objdump: one symbol from
		# glibc 2.29 has to fail it, 2.28 has to pass.
		if not VERIFY_GLIBC_SCRIPT.is_file():
			self.skipTest("the vscode submodule is not checked out")
		if not shutil.which("bash"):
			self.skipTest("no bash")
		for version, code in (("2.28", 0), ("2.29", 1)):
			with self.subTest(version=version), tempfile.TemporaryDirectory() as tmp:
				root = Path(tmp)
				bindir = root / "sysroot" / "x86_64-linux-gnu" / "x86_64-linux-gnu" / "bin"
				bindir.mkdir(parents=True)
				(bindir / "objdump").write_text(
					"#!/bin/sh\n"
					f"echo '0000000000000000      DF *UND*  0000000000000000 (GLIBC_{version}) memcpy'\n"
				)
				(bindir / "objdump").chmod(0o755)
				server = root / "server"
				server.mkdir()
				(server / "a.node").write_text("")
				env = {
					"PATH": "/usr/bin:/bin", "EXPECTED_GLIBC_VERSION": "2.28",
					"EXPECTED_GLIBCXX_VERSION": "3.4.25", "VSCODE_SYSROOT_DIR": str(root / "sysroot"),
					"VSCODE_ARCH": "x64", "SEARCH_PATH": str(server),
				}
				result = subprocess.run(["bash", str(VERIFY_GLIBC_SCRIPT)], env=env, capture_output=True, text=True)
				self.assertEqual(result.returncode, code, result.stdout + result.stderr)


class RetryCommandTest(unittest.TestCase):
	def test_lists_only_missing_targets(self) -> None:
		out = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, out, True)
		with mock.patch("build_reh.bundle_problems", lambda d, c, i, required: [] if required[0] in TARGETS[:2] else ["no"]):
			self.assertEqual(retry_command(out, TARGETS, "c", "i"), "scripts/build_reh.py alpine-x64 alpine-arm64")


class ServerCache(unittest.TestCase):
	IDENTITY = "a" * 12

	def setUp(self) -> None:
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root)
		self.out, self.cache = root / "out", root / "cache"
		self.out.mkdir()
		(self.out / tarball_name("linux-x64")).write_bytes(b"server")
		write_statement(self.out, "linux-x64", COMMIT, self.IDENTITY)

	def test_miss_then_hit_copies_into_the_bundle(self) -> None:
		fresh = self.out.parent / "fresh"
		self.assertFalse(restore_cached_server("linux-x64", COMMIT, self.IDENTITY, fresh, self.cache))
		store_cached_server("linux-x64", self.IDENTITY, self.out, self.cache)
		self.assertTrue(restore_cached_server("linux-x64", COMMIT, self.IDENTITY, fresh, self.cache))
		self.assertEqual(bundle_problems(fresh, COMMIT, self.IDENTITY, required=("linux-x64",)), [])
		self.assertFalse(restore_cached_server("alpine-x64", COMMIT, self.IDENTITY, fresh, self.cache))

	def test_other_identity_or_commit_is_a_miss(self) -> None:
		store_cached_server("linux-x64", self.IDENTITY, self.out, self.cache)
		fresh = self.out.parent / "fresh"
		self.assertFalse(restore_cached_server("linux-x64", COMMIT, "b" * 12, fresh, self.cache))
		self.assertIn("another", cached_server_problems(self.cache / self.IDENTITY, "linux-x64", "9" * 40, self.IDENTITY)[0])

	def test_a_corrupt_tarball_is_refused_and_dropped(self) -> None:
		store_cached_server("linux-x64", self.IDENTITY, self.out, self.cache)
		(self.cache / self.IDENTITY / tarball_name("linux-x64")).write_bytes(b"rotten")
		fresh = self.out.parent / "fresh"
		with mock.patch("builtins.print"):
			self.assertFalse(restore_cached_server("linux-x64", COMMIT, self.IDENTITY, fresh, self.cache))
		self.assertFalse((fresh / tarball_name("linux-x64")).exists())
		self.assertFalse((self.cache / self.IDENTITY / statement_name("linux-x64")).exists())

	def test_prune_stale_leaves_the_cache_alone(self) -> None:
		store_cached_server("linux-x64", self.IDENTITY, self.out, self.cache)
		prune_stale(self.out, "b" * 12)
		self.assertTrue((self.cache / self.IDENTITY / tarball_name("linux-x64")).is_file())

	def test_cache_root_follows_the_environment(self) -> None:
		with mock.patch.dict(os.environ, {"DEVHUB_REH_CACHE": "/x/y"}):
			self.assertEqual(reh_cache_root(), Path("/x/y"))
		with mock.patch.dict(os.environ, {"XDG_CACHE_HOME": "/xdg"}, clear=False):
			os.environ.pop("DEVHUB_REH_CACHE", None)
			self.assertEqual(reh_cache_root(), Path("/xdg/devhub/reh"))


class PruneCache(unittest.TestCase):
	def test_keeps_newest_and_the_current_identity(self) -> None:
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root)
		cache = root / "reh"
		for age, name in enumerate(["cur", "new", "mid", "old"]):
			(cache / name).mkdir(parents=True)
			os.utime(cache / name, (1000 - age * 10 if name != "cur" else 1, ) * 2)
		removed = prune_cache("cur", 1, cache)
		self.assertEqual(sorted(p.name for p in cache.iterdir()), ["cur", "new"])
		self.assertEqual(len(removed), 2)


MACHO = b"\xcf\xfa\xed\xfe" + b"\0" * 28


def elf(machine: int, extra: bytes = b"") -> bytes:
	return b"\x7fELF\x02\x01\x01" + b"\0" * 11 + machine.to_bytes(2, "little") + b"\0" * 12 + extra


class ForeignBinaries(unittest.TestCase):
	def setUp(self) -> None:
		self.root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, self.root)
		self.staging = self.root / "server"
		self.dist = self.staging / "extensions" / "microsoft-authentication" / "dist"
		self.dist.mkdir(parents=True)
		(self.dist / "extension.js").write_text("x")

	def test_mach_o_and_wrong_elf_are_fatal_under_any_name(self) -> None:
		bin_dir = self.staging / "node_modules" / "@vscode" / "ripgrep" / "bin"
		bin_dir.mkdir(parents=True)
		(bin_dir / "rg").write_bytes(MACHO)
		(self.staging / "arm.so").write_bytes(elf(0xB7))
		(self.staging / "ok.node").write_bytes(elf(0x3E))
		found = foreign_binaries(self.staging, "linux-x64")
		self.assertEqual(len(found), 2, found)
		self.assertTrue(any("rg: Mach-O" in p for p in found))
		self.assertTrue(any("arm.so: ELF for machine" in p for p in found))
		with self.assertRaises(SystemExit), mock.patch("builtins.print"):
			build_reh.refuse_foreign_binaries(self.staging, "linux-x64")

	def test_glibc_binary_on_musl(self) -> None:
		(self.staging / "a.node").write_bytes(elf(0x3E, b"libc.so.6"))
		(self.staging / "b.node").write_bytes(elf(0x3E, b"libc.musl-x86_64.so.1"))
		self.assertEqual(foreign_binaries(self.staging, "alpine-x64"), ["a.node: glibc ELF on a musl target"])
		self.assertEqual(foreign_binaries(self.staging, "linux-x64"), [])

	def test_only_other_platforms_prebuilds_are_exempt(self) -> None:
		pb = self.staging / "node_modules" / "x" / "prebuilds"
		(pb / "darwin-arm64").mkdir(parents=True)
		(pb / "darwin-arm64" / "x.node").write_bytes(MACHO)
		(pb / "linux-x64").mkdir()
		(pb / "linux-x64" / "x.node").write_bytes(MACHO)
		found = foreign_binaries(self.staging, "linux-x64")
		self.assertEqual(found, ["node_modules/x/prebuilds/linux-x64/x.node: Mach-O (macOS)"])

	def test_pe_files_are_inert_not_fatal(self) -> None:
		js = self.staging / "extensions" / "ms-vscode.js-debug" / "src"
		js.mkdir(parents=True)
		(js / "win32-app-container-tokens.win32-x64-msvc.node").write_bytes(b"MZ" + b"\0" * 30)
		(self.staging / "PSReadLine.dll").write_bytes(b"MZ" + b"\0" * 30)
		(self.staging / "fs.node").write_bytes(MACHO)
		self.assertEqual(foreign_binaries(self.staging, "linux-x64"), ["fs.node: Mach-O (macOS)"])
		self.assertEqual(len(windows_binaries(self.staging)), 2)

	def test_musl_servers_lose_upstreams_glibc_msal_runtime(self) -> None:
		# esbuild.mts picks the runtime by VSCODE_ARCH alone, so alpine-x64
		# gets linux/x64's glibc one, as upstream's own does.
		for name in ("msal-node-runtime.node", "libmsalruntime.so"):
			(self.dist / name).write_bytes(elf(0x3E, b"libc.so.6"))
		self.assertEqual(drop_glibc_msal_runtime(self.staging, "linux-x64"), [])
		self.assertEqual(len(foreign_binaries(self.staging, "alpine-x64")), 2)
		with mock.patch("builtins.print"):
			gone = drop_glibc_msal_runtime(self.staging, "alpine-x64")
		self.assertEqual(gone, ["libmsalruntime.so", "msal-node-runtime.node"])
		self.assertEqual(sorted(f.name for f in self.dist.iterdir()), ["extension.js"])
		self.assertEqual(foreign_binaries(self.staging, "alpine-x64"), [])


if __name__ == "__main__":
	unittest.main()
