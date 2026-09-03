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

import unittest

from product_metadata import (
	EXTENSION_ENABLED_API_PROPOSALS,
	devhub_commit,
	packaged_metadata,
	product_metadata,
	proposal_declaration_file,
	vscode_commit,
)


class SourceRunMetadata(unittest.TestCase):
	"""What apps/desktop/scripts/dev.sh writes to vscode/product.overrides.json."""

	def test_states_no_commit(self) -> None:
		self.assertNotIn("commit", product_metadata())

	def test_says_which_devhub_it_is_anyway(self) -> None:
		self.assertEqual(product_metadata()["hostCommit"], devhub_commit())


class PackagedMetadata(unittest.TestCase):
	"""What scripts/package-nightly.py merges over vscode/product.json."""

	def test_commit_is_the_vs_code_it_was_built_from(self) -> None:
		self.assertEqual(packaged_metadata()["commit"], vscode_commit())

	def test_devhub_hash_never_lands_in_commit(self) -> None:
		metadata = packaged_metadata()
		self.assertEqual(metadata["hostCommit"], devhub_commit())
		self.assertNotEqual(metadata["commit"], devhub_commit())

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
