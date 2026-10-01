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

import shutil
import tempfile
import unittest
from pathlib import Path

from product_metadata import (
	EXTENSION_ENABLED_API_PROPOSALS,
	PATCHES_DIR,
	devhub_commit,
	packaged_metadata,
	product_metadata,
	proposal_declaration_file,
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
		for patch in sorted(PATCHES_DIR.glob("*.patch"))[:2]:
			shutil.copyfile(patch, self.patches / patch.name)

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
		patch = next(self.patches.glob("*.patch"))
		patch.write_bytes(patch.read_bytes() + b"# changed\n")
		self.assertNotEqual(self.identity(), before)

	def test_moves_with_the_commit_and_the_revision(self) -> None:
		before = self.identity()
		self.assertNotEqual(self.identity(commit="1" * 40), before)
		self.assertNotEqual(self.identity(revision=2), before)


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
						proposal_declaration_file(proposal).is_file(),
						f"{extension} is granted {proposal}, which this VS Code does not declare",
					)

	def test_the_table_reaches_product_json(self) -> None:
		self.assertEqual(
			product_metadata()["extensionEnabledApiProposals"],
			EXTENSION_ENABLED_API_PROPOSALS,
		)


if __name__ == "__main__":
	unittest.main()
