#!/usr/bin/env python3
"""scripts/vscode_bump_supersede.py picks only older bump pull requests."""

from __future__ import annotations

import unittest

import vscode_bump_supersede as s


def pr(number: int, head: str, labels=("vscode-bump",), cross=False) -> dict:
	return {
		"number": number,
		"headRefName": head,
		"isCrossRepository": cross,
		"labels": [{"name": n} for n in labels],
	}


class SelectTest(unittest.TestCase):
	def numbers(self, prs, new):
		return [p["number"] for p in s.select_superseded(prs, new)]

	def test_semantic_not_lexical_compare(self):
		prs = [pr(1, "bump/vscode-1.9.0"), pr(2, "bump/vscode-1.141.2"), pr(3, "bump/vscode-1.142.0")]
		self.assertEqual(self.numbers(prs, "1.142.0"), [1, 2])
		self.assertEqual(self.numbers(prs, "1.141.10"), [1, 2])

	def test_equal_and_newer_are_kept(self):
		prs = [pr(1, "bump/vscode-1.142.0"), pr(2, "bump/vscode-1.143.0")]
		self.assertEqual(self.numbers(prs, "1.142.0"), [])

	def test_unrelated_prs_are_never_touched(self):
		prs = [
			pr(1, "bump/vscode-1.100.0", labels=()),
			pr(2, "feature/vscode-1.100.0"),
			pr(3, "bump/vscode-1.100.0", cross=True),
			pr(4, "bump/vscode-latest"),
			pr(5, "bump/vscode-1.100.0", labels=("other",)),
		]
		self.assertEqual(self.numbers(prs, "1.142.0"), [])

	def test_bad_new_version(self):
		self.assertEqual(self.numbers([pr(1, "bump/vscode-1.1.0")], "nightly"), [])

	def test_find_new_pr(self):
		prs = [pr(1, "bump/vscode-1.141.2"), pr(2, "bump/vscode-1.142.0")]
		self.assertEqual(s.find_new_pr(prs, "1.142.0")["number"], 2)
		self.assertIsNone(s.find_new_pr(prs, "1.143.0"))
		self.assertIsNone(s.find_new_pr([pr(2, "bump/vscode-1.142.0", labels=())], "1.142.0"))


if __name__ == "__main__":
	unittest.main()
