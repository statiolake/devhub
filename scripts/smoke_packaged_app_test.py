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

import unittest
from pathlib import Path

from smoke_packaged_app import SMOKE_PROFILE, launch_command, user_data_directory


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


if __name__ == "__main__":
	unittest.main()
