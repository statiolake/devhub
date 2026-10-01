#!/usr/bin/env python3
"""`pnpm dev` builds only this Mac's glibc server, and never blocks on it.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import dev_reh


class HostTargetTest(unittest.TestCase):
	def test_maps_cpu(self):
		self.assertEqual(dev_reh.host_target("arm64"), "linux-arm64")
		self.assertEqual(dev_reh.host_target("aarch64"), "linux-arm64")
		self.assertEqual(dev_reh.host_target("x86_64"), "linux-x64")
		self.assertEqual(dev_reh.host_target("AMD64"), "linux-x64")
		self.assertIsNone(dev_reh.host_target("riscv64"))

	def test_skip_values(self):
		self.assertTrue(dev_reh.skip_requested({"DEVHUB_SKIP_REH_BUILD": "1"}))
		self.assertFalse(dev_reh.skip_requested({"DEVHUB_SKIP_REH_BUILD": "0"}))
		self.assertFalse(dev_reh.skip_requested({}))


class EnsureTest(unittest.TestCase):
	def run_ensure(self, *, problems, docker=True, build_rc=0, env=None, target="linux-arm64"):
		calls = {"docker": 0, "build": []}

		def has_docker():
			calls["docker"] += 1
			return docker

		def build(t):
			calls["build"].append(t)
			return build_rc

		with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
			dev_reh, "target_problems", return_value=problems
		), mock.patch.object(dev_reh, "say") as say:
			rc = dev_reh.ensure(
				target, Path(tmp), env=env or {}, commit="c", identity="i",
				docker=has_docker, build=build,
			)
		return rc, calls, [c.args[0] for c in say.call_args_list]

	def test_current_skips_without_docker(self):
		rc, calls, out = self.run_ensure(problems=[])
		self.assertEqual((rc, calls["docker"], calls["build"], out), (0, 0, [], []))

	def test_real_empty_dir_is_missing(self):
		with tempfile.TemporaryDirectory() as tmp:
			self.assertEqual(len(dev_reh.target_problems("linux-x64", Path(tmp), "c", "i")), 1)

	def test_missing_builds_with_progress_note(self):
		rc, calls, out = self.run_ensure(problems=["no linux-arm64 server"])
		self.assertEqual((rc, calls["build"]), (0, ["linux-arm64"]))
		self.assertTrue(any("15 minutes" in m and "DEVHUB_SKIP_REH_BUILD" in m for m in out))

	def test_no_docker_warns_and_continues(self):
		rc, calls, out = self.run_ensure(problems=["x"], docker=False)
		self.assertEqual((rc, calls["build"]), (0, []))
		self.assertTrue(any("scripts/build_reh.py linux-arm64" in m and "Remote" in m for m in out))

	def test_failed_build_warns_and_continues(self):
		rc, calls, out = self.run_ensure(problems=["x"], build_rc=1)
		self.assertEqual(rc, 0)
		self.assertTrue(any("failed" in m and "log" in m for m in out))

	def test_opt_out(self):
		rc, calls, _ = self.run_ensure(problems=["x"], env={"DEVHUB_SKIP_REH_BUILD": "1"})
		self.assertEqual((rc, calls["docker"], calls["build"]), (0, 0, []))

	def test_unknown_cpu(self):
		rc, calls, _ = self.run_ensure(problems=["x"], target=None)
		self.assertEqual((rc, calls["build"]), (0, []))


if __name__ == "__main__":
	unittest.main()
