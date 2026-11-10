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

import hashlib

import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from smoke_packaged_app import (
	SMOKE_PROFILE,
	check_app_layout,
	launch_command,
	outlives,
	source_launch_command,
	user_data_directory,
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

	def test_publishes_its_theme_into_the_throwaway_state(self) -> None:
		"""`XDG_STATE_HOME` moves the theme file the appearance check reads."""
		self.assertTrue(Path(self.environment["XDG_STATE_HOME"]).is_relative_to(self.state))

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
		for name in ("HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "TMUX_TMPDIR"):
			self.assertTrue(Path(self.environment[name]).is_relative_to(self.state), name)

	def test_keeps_the_path(self) -> None:
		self.assertEqual(self.environment["PATH"], "/usr/bin")


class AfterTheOpen(unittest.TestCase):
	"""The app has to outlive the file it opened, not just answer the socket."""

	def start(self, script: str) -> subprocess.Popen:
		process = subprocess.Popen([sys.executable, "-I", "-c", script])
		self.addCleanup(process.wait)
		self.addCleanup(process.kill)
		return process

	def test_passes_when_the_app_keeps_running(self) -> None:
		self.assertIsNone(outlives(self.start("import time; time.sleep(30)"), settle=0.5))

	def test_fails_when_the_app_dies_meanwhile(self) -> None:
		problem = outlives(self.start("import time; time.sleep(0.2)"), settle=3)
		self.assertIn("exited after opening the file", problem or "")


class AppLayout(unittest.TestCase):
	"""What `Resources/app` must hold before the app is worth starting."""

	def setUp(self) -> None:
		self.directory = tempfile.TemporaryDirectory()
		self.app = Path(self.directory.name)

	def tearDown(self) -> None:
		self.directory.cleanup()

	def write(self, relative: str, text: str = "x") -> None:
		path = self.app / relative
		path.parent.mkdir(parents=True, exist_ok=True)
		path.write_text(text)

	def lay_out(self) -> None:
		self.write("package.json", '{"main": "out/main/main.js"}')
		self.write("product.json", '{"commit": "abc"}')
		for relative in (
			"out/main/main.js",
			"out/vt/ghostty-vt.wasm",
			"dist/shell/index.html",
			"node_modules/node-pty/prebuilds/linux-x64/pty.node",
			"out/nvim/share/nvim/runtime/filetype.lua",
		):
			self.write(relative)
		self.write("out/nvim/bin/nvim", "#!/bin/sh\n")
		(self.app / "out/nvim/bin/nvim").chmod(0o755)
		self.write("out/bash/bin/bash", "#!/bin/sh\n")
		(self.app / "out/bash/bin/bash").chmod(0o755)
		self.write("out/tmux/bin/tmux", "#!/bin/sh\n")
		(self.app / "out/tmux/bin/tmux").chmod(0o755)
		self.write("out/tmux/terminfo/t/tmux-256color")
		sums = []
		for name in ("darwin-arm64", "linux-x64", "linux-arm64"):
			binary = self.app / "out" / "cli" / name / "devhub"
			self.write(f"out/cli/{name}/devhub", f"devhub for {name}")
			binary.chmod(0o755)
			sums.append(f"{hashlib.sha256(binary.read_bytes()).hexdigest()}  {name}/devhub")
		self.write("out/cli/SHA256SUMS", "\n".join(sums) + "\n")

	def test_a_whole_layout_passes(self) -> None:
		self.lay_out()
		self.assertEqual(check_app_layout(self.app, "linux-x64"), [])

	def test_names_a_devhub_that_is_missing_or_not_the_build_s(self) -> None:
		self.lay_out()
		(self.app / "out/cli/linux-arm64/devhub").unlink()
		(self.app / "out/cli/linux-x64/devhub").write_text("changed")
		faults = check_app_layout(self.app, "linux-x64")
		self.assertTrue(any("linux-arm64/devhub is missing" in fault for fault in faults))
		self.assertTrue(any("linux-x64/devhub does not match" in fault for fault in faults))

	def test_names_a_missing_wasm_and_a_missing_prebuild(self) -> None:
		self.lay_out()
		(self.app / "out/vt/ghostty-vt.wasm").unlink()
		faults = check_app_layout(self.app, "darwin-arm64")
		self.assertTrue(any("ghostty-vt.wasm" in fault for fault in faults))
		self.assertTrue(any("darwin-arm64" in fault for fault in faults))

	def test_names_a_missing_neovim(self) -> None:
		self.lay_out()
		(self.app / "out/nvim/bin/nvim").unlink()
		faults = check_app_layout(self.app, "linux-x64")
		self.assertTrue(any("out/nvim/bin/nvim" in fault for fault in faults))

	def test_names_a_missing_bash(self) -> None:
		self.lay_out()
		(self.app / "out/bash/bin/bash").unlink()
		faults = check_app_layout(self.app, "linux-x64")
		self.assertTrue(any("out/bash/bin/bash" in fault for fault in faults))

	def test_names_a_missing_tmux(self) -> None:
		self.lay_out()
		(self.app / "out/tmux/bin/tmux").unlink()
		faults = check_app_layout(self.app, "linux-x64")
		self.assertTrue(any("out/tmux/bin/tmux" in fault for fault in faults))

	def test_names_a_build_that_states_no_commit(self) -> None:
		self.lay_out()
		self.write("product.json", "{}")
		self.assertTrue(any("commit" in fault for fault in check_app_layout(self.app, "linux-x64")))


if __name__ == "__main__":
	unittest.main()
