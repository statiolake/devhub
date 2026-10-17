#!/usr/bin/env python3
"""`commit` says "packaged", and a source run must never say it.

One field decides which of the two layouts the workbench believes it is in.
`vscode/src/vs/amdX.ts` computes `isBuilt = Boolean(product.commit)` and then
resolves vscode-textmate, vscode-oniguruma and xterm out of `node_modules.asar`
— an archive only the packaged app has. A source run that states a commit loses
syntax highlighting and the terminal to ERR_FILE_NOT_FOUND, with nothing in the
app to say why. It happened, which is why these tests exist.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from product_metadata import (
	EXTENSION_ENABLED_API_PROPOSALS,
	REPO_ROOT,
	VSCODE_DIR,
	is_client_only,
	overlay_files,
	devhub_commit,
	nls_metadata_hash,
	packaged_metadata,
	product_metadata,
	proposal_is_declared,
	reh_identity,
	vscode_commit,
)


class SourceRunMetadata(unittest.TestCase):
	"""What apps/desktop/scripts/dev.sh writes to vscode/product.overrides.json."""

	def test_states_no_commit(self) -> None:
		self.assertNotIn("commit", product_metadata())

	def test_says_which_devhub_it_is_anyway(self) -> None:
		self.assertEqual(product_metadata()["hostCommit"], devhub_commit())

	def test_says_which_remote_extension_host_it_connects_to(self) -> None:
		# Without it a source run has no REH to install in a dev container or
		# on an SSH host, and every remote window it opens never connects.
		self.assertEqual(product_metadata()["serverCommit"], vscode_commit())


class ServerIdentity(unittest.TestCase):
	"""The second half of the directory a far machine keeps its server under."""

	def setUp(self) -> None:
		self.patches = Path(tempfile.mkdtemp(prefix="patches-"))
		self.addCleanup(lambda: shutil.rmtree(self.patches, ignore_errors=True))
		# One patch the server bundles, one it does not.
		(self.patches / "0001-server.patch").write_text(
			"--- a/src/vs/workbench/api/common/extHost.protocol.ts\n"
			"+++ b/src/vs/workbench/api/common/extHost.protocol.ts\n@@ -1 +1 @@\n-a\n+b\n"
		)
		(self.patches / "0002-client.patch").write_text(
			"--- a/src/vs/workbench/browser/parts/x.ts\n"
			"+++ b/src/vs/workbench/browser/parts/x.ts\n@@ -1 +1 @@\n-a\n+b\n"
		)

	def identity(self, **overrides: object) -> str:
		arguments: dict = {"commit": "0" * 40, "patches_dir": self.patches, "revision": 1}
		arguments.update(overrides)
		return reh_identity(**arguments)

	def test_is_stated_by_a_source_run_and_a_packaged_build_alike(self) -> None:
		self.assertEqual(product_metadata()["serverIdentity"], reh_identity())
		self.assertEqual(packaged_metadata()["serverIdentity"], reh_identity())

	def test_is_twelve_hex_characters(self) -> None:
		self.assertRegex(self.identity(), r"^[0-9a-f]{12}$")

	def test_moves_when_a_patch_does_and_not_otherwise(self) -> None:
		# The failure this exists for: a patch changed the server, the commit
		# did not move, and every machine kept the server it already had.
		before = self.identity()
		self.assertEqual(self.identity(), before)
		patch = self.patches / "0001-server.patch"
		patch.write_bytes(patch.read_bytes() + b"# changed\n")
		self.assertNotEqual(self.identity(), before)

	def test_ignores_a_patch_no_server_contains(self) -> None:
		before = self.identity()
		patch = self.patches / "0002-client.patch"
		patch.write_bytes(patch.read_bytes() + b"# changed\n")
		self.assertEqual(self.identity(), before)
		# One file the server has is enough to make it the server's.
		patch.write_text(
			patch.read_text()
			+ "--- a/src/vs/platform/keybinding/common/keybindingsRegistry.ts\n"
			"+++ b/src/vs/platform/keybinding/common/keybindingsRegistry.ts\n@@ -1 +1 @@\n-a\n+b\n"
		)
		self.assertNotEqual(self.identity(), before)

	def test_ignores_an_overlay_file_no_server_contains(self) -> None:
		overlay = self.patches / "overlay"
		path = overlay / "src" / "vs" / "workbench" / "contrib" / "devhubVim" / "common" / "vimEngine.ts"
		path.parent.mkdir(parents=True)
		path.write_text("one\n")
		before = self.identity(overlay_dir=overlay)
		path.write_text("two\n")
		self.assertEqual(self.identity(overlay_dir=overlay), before)

	def test_moves_when_an_overlay_file_does(self) -> None:
		overlay = self.patches / "overlay"
		(overlay / "src" / "vs" / "workbench" / "api" / "common").mkdir(parents=True)
		path = overlay / "src" / "vs" / "workbench" / "api" / "common" / "x.ts"
		path.write_text("one\n")
		before = self.identity(overlay_dir=overlay)
		self.assertEqual(self.identity(overlay_dir=overlay), before)
		path.write_text("two\n")
		self.assertNotEqual(self.identity(overlay_dir=overlay), before)

	def test_moves_with_the_commit_and_the_revision(self) -> None:
		before = self.identity()
		self.assertNotEqual(self.identity(commit="1" * 40), before)
		self.assertNotEqual(self.identity(revision=2), before)

	def test_moves_when_a_build_script_does(self) -> None:
		# A prebuilt server from before a fix to the script that made it must
		# not be reused, even when nobody bumped REH_REVISION.
		script = self.patches / "build_reh.py"
		script.write_text("one\n")
		before = self.identity(build_scripts=(script,))
		self.assertEqual(self.identity(build_scripts=(script,)), before)
		script.write_text("two\n")
		self.assertNotEqual(self.identity(build_scripts=(script,)), before)

	def test_moves_with_the_metadata_the_server_carries(self) -> None:
		before = self.identity(metadata={"nameShort": "DevHub"})
		self.assertEqual(self.identity(metadata={"nameShort": "DevHub"}), before)
		self.assertNotEqual(self.identity(metadata={"nameShort": "Other"}), before)

	def test_covers_the_real_build_scripts(self) -> None:
		from product_metadata import REH_BUILD_SCRIPTS

		names = {p.name for p in REH_BUILD_SCRIPTS}
		self.assertEqual(names, {"build_reh.py", "reh_in_container.sh"})
		self.assertTrue(all(p.is_file() for p in REH_BUILD_SCRIPTS))


class ClientOnlyPaths(unittest.TestCase):
	"""`REH_CLIENT_ONLY` holds only what no server contains.

	The server is esbuild bundles of upstream's server entry points
	(`node build/next/index.ts bundle --target server`), so what it contains is
	their import graph. This bundles that graph from the patched tree (a
	checkout where scripts/apply-vscode-patches.sh has run, as CI's checks job
	does) with the esbuild DevHub's own build has, and fails on any module of it
	the identity leaves out.
	"""

	def esbuild(self) -> str:
		for candidate in (
			REPO_ROOT / "apps" / "desktop" / "node_modules" / ".bin" / "esbuild",
			VSCODE_DIR / "node_modules" / ".bin" / "esbuild",
		):
			if candidate.is_file():
				return str(candidate)
		found = shutil.which("esbuild")
		if found is None:
			self.skipTest("no esbuild (pnpm install)")
		return found

	def entry_points(self) -> list[str]:
		index = (VSCODE_DIR / "build" / "next" / "index.ts").read_text()
		block = re.search(r"const serverEntryPoints = \[(.*?)\];", index, re.S)
		self.assertIsNotNone(block, "build/next/index.ts no longer lists serverEntryPoints")
		entries = re.findall(r"'([^']+)'", block.group(1))
		bootstrap = (VSCODE_DIR / "build" / "lib" / "esbuild.ts").read_text()
		server = re.search(r"case 'server':\s*case 'server-web':\s*return \[([^\]]*)\]", bootstrap)
		self.assertIsNotNone(server, "build/lib/esbuild.ts no longer lists the server's bootstrap entry points")
		entries += re.findall(r"'([^']+)'", server.group(1))
		return [f"src/{entry}.ts" for entry in entries]

	def test_no_server_module_is_left_out_of_the_identity(self) -> None:
		if not (VSCODE_DIR / "build" / "next" / "index.ts").is_file():
			self.skipTest("the vscode submodule is not checked out")
		if not all((VSCODE_DIR / p).is_file() for p in overlay_files()):
			self.skipTest("the vscode submodule is not patched (scripts/apply-vscode-patches.sh)")
		esbuild = self.esbuild()
		with tempfile.TemporaryDirectory() as tmp:
			meta = Path(tmp) / "meta.json"
			result = subprocess.run(
				[
					esbuild, *self.entry_points(), "--bundle", "--platform=node", "--format=esm",
					"--packages=external", "--external:electron", "--loader:.css=empty",
					f"--outdir={tmp}/out", f"--metafile={meta}", "--log-level=error",
				],
				cwd=VSCODE_DIR, capture_output=True, text=True,
			)
			self.assertEqual(result.returncode, 0, result.stderr[-2000:])
			inputs = set(json.loads(meta.read_text())["inputs"])
		# The graph is the real one: the extension host's half of the hover is in it.
		self.assertIn("src/vs/workbench/api/common/extHostStatusBar.ts", inputs)
		self.assertIn("src/vs/workbench/api/common/devhubStatusBarHover.ts", inputs)
		self.assertEqual(sorted(p for p in inputs if is_client_only(p)), [])


class PackagedMetadata(unittest.TestCase):
	"""What scripts/package-nightly.py merges over vscode/product.json."""

	def test_commit_is_the_vs_code_it_was_built_from(self) -> None:
		self.assertEqual(packaged_metadata()["commit"], vscode_commit())

	def test_devhub_hash_never_lands_in_commit(self) -> None:
		metadata = packaged_metadata()
		self.assertEqual(metadata["hostCommit"], devhub_commit())
		self.assertNotEqual(metadata["commit"], devhub_commit())

	def test_server_commit_is_the_commit(self) -> None:
		metadata = packaged_metadata()
		self.assertEqual(metadata["serverCommit"], metadata["commit"])

	def test_commit_is_hex_vs_code_can_slice(self) -> None:
		# It becomes cache keys and folder names, so anything but lowercase hex
		# — a tag, a `-dirty` suffix — is a path the app then cannot find.
		commit = packaged_metadata()["commit"]
		self.assertRegex(commit, r"^[0-9a-f]{40}$")


class NlsMetadataHash(unittest.TestCase):
	"""`nlsMetadataHash`, the name of a language pack's cached translation.

	Without it VS Code keys the cache by `commit` alone, which DevHub's patches
	do not move, so a build whose patches moved a `localize` call read an
	earlier build's translated table and showed each message's neighbour.
	"""

	COMMIT = "a44adf7f53e00964ab890f9f8758a334f1fc15bc"
	KEYS = b'[["vs/a",["k1","k2"]]]'
	MESSAGES = b'["One","Two"]'
	# What upstream's computeNLSMetadataHash (vscode/build/lib/nlsMetadata.ts
	# at 1.141) answers for the table above.
	UPSTREAM = "2565876f0c380cb3092a2bb5c35e52a51925f301825f37d558732dc11144930c"

	def setUp(self) -> None:
		self.out = Path(tempfile.mkdtemp(prefix="nls-"))
		self.addCleanup(lambda: shutil.rmtree(self.out, ignore_errors=True))
		self.write(self.KEYS, self.MESSAGES)

	def write(self, keys: bytes, messages: bytes) -> None:
		(self.out / "nls.keys.json").write_bytes(keys)
		(self.out / "nls.messages.json").write_bytes(messages)

	def test_is_upstreams_hash(self) -> None:
		self.assertEqual(nls_metadata_hash(self.out, self.COMMIT), self.UPSTREAM)

	def test_agrees_with_the_pinned_upstream_implementation(self) -> None:
		# The same check against the submodule's own source, where a Node that
		# runs TypeScript is at hand: a bump that changes the algorithm fails
		# here instead of silently caching per commit again.
		source = VSCODE_DIR / "build" / "lib" / "nlsMetadata.ts"
		if not source.is_file() or shutil.which("node") is None:
			self.skipTest("no vscode/build/lib/nlsMetadata.ts or node")
		script = (
			f"import({json_string(source.as_uri())})"
			f".then(m => console.log(m.computeNLSMetadataHash({json_string(str(self.out))}, {json_string(self.COMMIT)})))"
		)
		result = subprocess.run(
			["node", "--experimental-strip-types", "--no-warnings", "-e", script],
			capture_output=True,
			text=True,
		)
		if result.returncode != 0:
			self.skipTest(f"node cannot run TypeScript here: {result.stderr.strip()[:200]}")
		self.assertEqual(result.stdout.strip(), nls_metadata_hash(self.out, self.COMMIT))

	def test_moves_when_the_table_does_under_the_same_commit(self) -> None:
		before = nls_metadata_hash(self.out, self.COMMIT)
		self.write(b'[["vs/a",["k0","k1","k2"]]]', b'["Zero","One","Two"]')
		self.assertNotEqual(nls_metadata_hash(self.out, self.COMMIT), before)

	def test_moves_when_only_an_english_message_does(self) -> None:
		before = nls_metadata_hash(self.out, self.COMMIT)
		self.write(self.KEYS, b'["One!","Two"]')
		self.assertNotEqual(nls_metadata_hash(self.out, self.COMMIT), before)

	def test_moves_with_the_commit(self) -> None:
		self.assertNotEqual(
			nls_metadata_hash(self.out, "0" * 40), nls_metadata_hash(self.out, self.COMMIT)
		)


def json_string(value: str) -> str:
	return json.dumps(value)


class EnabledApiProposals(unittest.TestCase):
	"""Which extensions may use which unfinished APIs.

	The table is copied from each extension's own `enabledApiProposals`, and
	the pinned VS Code is free to have renamed or finished any of those names
	between releases. A name the submodule does not declare is not inert: the
	workbench warns about an unknown proposal at startup, and the entry that
	was supposed to unlock the extension unlocks nothing.
	"""

	def test_every_proposal_exists_in_the_pinned_vs_code(self) -> None:
		for extension, proposals in EXTENSION_ENABLED_API_PROPOSALS.items():
			for proposal in proposals:
				with self.subTest(extension=extension, proposal=proposal):
					self.assertTrue(
						proposal_is_declared(proposal),
						f"{extension} is granted {proposal}, which this VS Code does not declare",
					)

	def test_a_proposal_the_overlay_adds_is_declared(self) -> None:
		root = Path(tempfile.mkdtemp())
		self.addCleanup(shutil.rmtree, root, True)
		self.assertFalse(proposal_is_declared("devhubNothing", root / "patches", root / "overlay"))
		dts = root / "overlay" / "src" / "vscode-dts" / "vscode.proposed.devhubNothing.d.ts"
		dts.parent.mkdir(parents=True)
		dts.write_text("declare module 'vscode' {}\n")
		self.assertTrue(proposal_is_declared("devhubNothing", root / "patches", root / "overlay"))

	def test_the_table_reaches_product_json(self) -> None:
		self.assertEqual(
			product_metadata()["extensionEnabledApiProposals"],
			EXTENSION_ENABLED_API_PROPOSALS,
		)


if __name__ == "__main__":
	unittest.main()
