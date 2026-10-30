#!/usr/bin/env python3
"""The smoke test must not be able to touch a DevHub somebody is using.

Starting the packaged app on the default profile is not a neutral act: that
instance is the user's DevHub. It reads `~/.config/devhub`, it attaches to the
tmux socket `devhub`, and it reaps every DevHub-marked Agent session missing
from its own state file — which, launched against a throwaway user-data
directory, is all of them. A local build did exactly that, three times in one
day. So the launch is pinned here: profile, config directory and editor state
all have to be somewhere disposable, and each of the three moves by a different
mechanism, so each is asserted separately.

    python3 -m unittest discover -s scripts -p "*_test.py"
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from smoke_packaged_app import (
	SMOKE_PROFILE,
	launch_command,
	source_launch_command,
	user_data_directory,
	no_workbench_for,
	wait_for_workbench,
	workbench_created,
	workbench_loaded,
)


class Launch(unittest.TestCase):
	"""What `smoke` hands to Popen, without starting Electron to find out."""

	def setUp(self) -> None:
		self.state = Path("/state")
		self.argv, self.environment = launch_command(
			Path("/bundle/DevHub.app/Contents/MacOS/DevHub"),
			self.state,
			{"HOME": "/home/tester", "PATH": "/usr/bin"},
		)

	def test_runs_under_its_own_profile(self) -> None:
		"""The profile name is what moves the tmux socket to `devhub-smoke`."""
		self.assertEqual(self.environment["DEVHUB_PROFILE"], SMOKE_PROFILE)
		self.assertNotEqual(SMOKE_PROFILE, "default")

	def test_reads_settings_from_the_throwaway_state(self) -> None:
		"""`XDG_CONFIG_HOME` is the only thing that moves the config directory."""
		config_home = Path(self.environment["XDG_CONFIG_HOME"])
		self.assertTrue(config_home.is_relative_to(self.state))

	def test_keeps_the_rest_of_the_environment(self) -> None:
		"""The app still needs a HOME and a PATH to start at all."""
		self.assertEqual(self.environment["HOME"], "/home/tester")
		self.assertEqual(self.environment["PATH"], "/usr/bin")

	def test_editor_state_is_the_directory_the_socket_is_probed_in(self) -> None:
		"""The control socket lives under the user-data directory, so they agree."""
		user_data = user_data_directory(self.state)
		self.assertTrue(user_data.is_relative_to(self.state))
		self.assertIn(str(user_data), self.argv)
		self.assertEqual(self.argv[self.argv.index("--user-data-dir") + 1], str(user_data))

	def test_extensions_are_installed_into_the_throwaway_state(self) -> None:
		extensions = Path(self.argv[self.argv.index("--extensions-dir") + 1])
		self.assertTrue(extensions.is_relative_to(self.state))


class SourceLaunch(unittest.TestCase):
	"""A source run (`--source`) moves the same three things, plus HOME, which
	is what `dev.sh` derives the editor's directories from."""

	def setUp(self) -> None:
		self.state = Path("/state")
		self.argv, self.environment = source_launch_command(
			Path("/repo"),
			self.state,
			["--no-sandbox"],
			{"HOME": "/home/tester", "PATH": "/usr/bin"},
		)

	def test_starts_dev_sh_with_the_extra_arguments(self) -> None:
		self.assertEqual(self.argv, ["/repo/apps/desktop/scripts/dev.sh", "--no-sandbox"])

	def test_runs_under_its_own_profile(self) -> None:
		self.assertEqual(self.environment["DEVHUB_PROFILE"], SMOKE_PROFILE)

	def test_moves_home_config_and_tmux_into_the_throwaway_state(self) -> None:
		for name in ("HOME", "XDG_CONFIG_HOME", "TMUX_TMPDIR"):
			self.assertTrue(Path(self.environment[name]).is_relative_to(self.state), name)

	def test_builds_no_remote_extension_host(self) -> None:
		self.assertEqual(self.environment["DEVHUB_SKIP_REH_BUILD"], "1")
		self.assertEqual(self.environment["PATH"], "/usr/bin")


LOADED = "[devhub] workbench view 1000007: its page has finished loading\n"


class AfterTheReply(unittest.TestCase):
	"""The app has to outlive its first workbench, not just answer the socket.

	On Electron 43 the main process crashed as the first workbench view
	committed its navigation, about a second after the socket had answered, so
	a reply alone passed a bundle that could not start.
	"""

	def setUp(self) -> None:
		self.directory = tempfile.TemporaryDirectory()
		self.log = Path(self.directory.name) / "app.log"

	def tearDown(self) -> None:
		self.directory.cleanup()

	def start(self, script: str) -> subprocess.Popen:
		process = subprocess.Popen([sys.executable, "-I", "-c", script])
		self.addCleanup(process.wait)
		self.addCleanup(process.kill)
		return process

	def test_recognises_the_line_a_loaded_workbench_prints(self) -> None:
		self.assertTrue(workbench_loaded("noise\n" + LOADED))
		self.assertFalse(workbench_loaded("[devhub] workbench view 1000007 created — 1 view(s) in the shell\n"))

	def test_passes_when_the_app_outlives_a_loaded_workbench(self) -> None:
		self.log.write_text(LOADED)
		process = self.start("import time; time.sleep(30)")
		self.assertIsNone(wait_for_workbench(process, self.log, time.monotonic() + 10, settle=0.5))

	def test_fails_when_the_app_dies_before_a_workbench_loads(self) -> None:
		self.log.write_text("[devhub] workbench view 1000007 created — 1 view(s) in the shell\n")
		process = self.start("import os, signal; os.kill(os.getpid(), signal.SIGSEGV)")
		problem = wait_for_workbench(process, self.log, time.monotonic() + 10, settle=0.5)
		self.assertIsNotNone(problem)
		self.assertIn("before any workbench loaded", problem or "")

	def test_fails_when_the_app_dies_during_the_settle_period(self) -> None:
		self.log.write_text(LOADED)
		process = self.start("import time; time.sleep(0.3)")
		problem = wait_for_workbench(process, self.log, time.monotonic() + 10, settle=5)
		self.assertIn("after a workbench loaded", problem or "")

	def test_fails_when_no_workbench_loads_in_time(self) -> None:
		self.log.write_text("")
		process = self.start("import time; time.sleep(30)")
		problem = wait_for_workbench(process, self.log, time.monotonic() + 0.5, settle=0.5)
		self.assertIn("in time", problem or "")


class BeforeAnyIsAskedFor(unittest.TestCase):
	"""No workbench is started until `toggle_editor` asks for one: every
	Workspace's editor area shows its terminal first (docs/terminal-mode.md)."""

	def setUp(self) -> None:
		self.directory = tempfile.TemporaryDirectory()
		self.log = Path(self.directory.name) / "app.log"

	def tearDown(self) -> None:
		self.directory.cleanup()

	def start(self, script: str) -> subprocess.Popen:
		process = subprocess.Popen([sys.executable, "-I", "-c", script])
		self.addCleanup(process.wait)
		self.addCleanup(process.kill)
		return process

	def test_recognises_the_line_a_made_workbench_prints(self) -> None:
		self.assertTrue(workbench_created("[devhub] workbench view 1000007 created — 1 view(s) in the shell\n"))
		self.assertFalse(workbench_created("[devhub] workbench 'a' absent -> asleep: not started: not shown yet\n"))

	def test_passes_while_none_is_made(self) -> None:
		self.log.write_text("[devhub] workbench '/x' absent -> asleep: not started: not shown yet\n")
		process = self.start("import time; time.sleep(30)")
		self.assertIsNone(no_workbench_for(process, self.log, 0.5))

	def test_fails_when_one_is_made_unasked(self) -> None:
		self.log.write_text("[devhub] workbench view 1000007 created — 1 view(s) in the shell\n")
		process = self.start("import time; time.sleep(30)")
		self.assertIn("before any was asked for", no_workbench_for(process, self.log, 0.5) or "")


if __name__ == "__main__":
	unittest.main()
