#!/usr/bin/env python3
"""The packaging path builds only the missing or stale servers."""

from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

import ensure_reh


class InCiTest(unittest.TestCase):
	def test_values(self):
		self.assertTrue(ensure_reh.in_ci({"CI": "true"}))
		self.assertFalse(ensure_reh.in_ci({"CI": ""}))
		self.assertFalse(ensure_reh.in_ci({"CI": "0"}))
		self.assertFalse(ensure_reh.in_ci({}))


class EnsureTest(unittest.TestCase):
	def run_ensure(self, env, problems, docker=True, build_rc=0):
		built = []

		def build(targets, log, extra):
			built.append((list(targets), extra))
			return build_rc

		def fake(target, *a):
			return problems.get(target, [])

		err = io.StringIO()
		with tempfile.TemporaryDirectory() as d, mock.patch.object(
			ensure_reh, "target_problems", fake
		), redirect_stderr(err):
			rc = ensure_reh.ensure(
				Path(d), env=env, commit="c", identity="i", docker=lambda: docker, build=build
			)
		return rc, built, err.getvalue()

	def test_builds_only_missing(self):
		rc, built, err = self.run_ensure({}, {"linux-x64": ["no"], "alpine-arm64": ["stale"]})
		self.assertEqual(rc, 0)
		self.assertEqual(built[0][0], ["linux-x64", "alpine-arm64"])
		self.assertIn("15 minutes", err)

	def test_failed_build_retry_lists_only_what_is_still_missing(self):
		problems = {"alpine-x64": ["no"], "alpine-arm64": ["no"]}

		def build(targets, log, extra):
			problems.pop("alpine-x64")  # built before the other one failed
			return 1

		err = io.StringIO()
		with tempfile.TemporaryDirectory() as d, mock.patch.object(
			ensure_reh, "target_problems", lambda t, *a: problems.get(t, [])
		), redirect_stderr(err):
			rc = ensure_reh.ensure(Path(d), env={}, commit="c", identity="i", docker=lambda: True, build=build)
		self.assertEqual(rc, 1)
		self.assertIn("Retry with: scripts/build_reh.py alpine-arm64,", err.getvalue())
		self.assertNotIn("alpine-x64", err.getvalue().split("Still missing")[1])

	def test_nothing_missing_no_docker_needed(self):
		rc, built, _ = self.run_ensure({}, {}, docker=False)
		self.assertEqual((rc, built), (0, []))

	def test_ci_never_builds(self):
		rc, built, _ = self.run_ensure({"CI": "true"}, {"linux-x64": ["no"]})
		self.assertEqual((rc, built), (0, []))

	def test_no_docker_names_targets_and_escape(self):
		rc, built, err = self.run_ensure({}, {"linux-x64": ["no"]}, docker=False)
		self.assertEqual((rc, built), (1, []))
		self.assertIn("linux-x64", err)
		self.assertIn("scripts/build_reh.py linux-x64", err)
		self.assertIn("--without-reh", err)

	def test_build_failure(self):
		rc, _, err = self.run_ensure({}, {"linux-x64": ["no"]}, build_rc=2)
		self.assertEqual(rc, 1)
		self.assertIn("--without-reh", err)


if __name__ == "__main__":
	unittest.main()
