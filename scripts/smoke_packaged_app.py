#!/usr/bin/env python3
"""Launch a packaged DevHub.app and make it answer on its control socket.

A packaged app can look completely healthy and still be useless. It opens its
window, it boots the workbench, it starts the extension host — and answers
nothing, because its main thread is parked inside a synchronous macOS call and
Electron has stopped pumping libuv behind it. Timers stop, sockets stop, the
`devhub` command hangs forever. Nothing about the bundle's contents says so, so
the only way to know is to start the app and ask it something.

That is what this does: it starts the bundle against a throwaway user-data
directory, sends the `version` request the `devhub` CLI sends, and requires a
reply. A reply means the main process is still running its event loop after
startup, which is the property that keeps breaking.

A reply is not the end of startup, though. The control socket opens before
VS Code's own application starts and before the first workbench view loads,
and a crash there passed this test for a whole VS Code bump: on Electron 43
the main process died the moment the first workbench view committed its
navigation, a second after the socket had answered. So after the reply the
app is kept running until a workbench view reports that its page finished
loading, and it has to still be alive when that happens. See
`wait_for_workbench`. DevHub starts no workbench by itself — every
Workspace's editor area shows its terminal until `Cmd+Q E` asks for its VS
Code editor — so the smoke first requires that none is made for a few
seconds, then runs `toggle_editor` over the socket the way `devhub --tell
run` does, which starts Scratch's.

It also reads the bundle before starting it, for the faults a reply cannot
rule out. An asset the workbench fetches by path — a wasm file, say — going
missing takes one feature down and leaves the rest of the app answering
normally, so no question asked of a running DevHub would ever find it. See
`check_bundle_layout`.

It starts the app under its own profile, `smoke`, and that is not a detail.
A DevHub launched on the *default* profile is the user's DevHub: it reads
`~/.config/devhub`, it attaches to the tmux socket `devhub`, and on startup it
reaps every DevHub-marked Agent session that its own state file does not know
about. A throwaway `--user-data-dir` gives it an empty state file, so the
reaping is total: every Agent the person is actually running dies. `smoke` is
what keeps the test off all of it — the profile name derives the tmux socket
(`devhub-smoke`), the data directories and the bundle identifier — and
`XDG_CONFIG_HOME` under the same throwaway directory moves the config directory
with it. See apps/desktop/src/model/profile.ts.

Run it standalone against any bundle:

    scripts/smoke_packaged_app.py path/to/DevHub.app

or against a source run — `apps/desktop/scripts/dev.sh`, what `pnpm dev`
starts — which is how it runs where no bundle can be built (Linux, under
`xvfb-run`; see scripts/test-local.sh). The startup checks are the same; the
bundle-layout checks are the bundle's own and are left out:

    scripts/smoke_packaged_app.py --source [--electron-arg=--no-sandbox]
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def probe(socket_path: Path, deadline: float, request: dict | None = None) -> dict:
	"""Ask the running app for its version (or `request`), or raise once the
	deadline passes.

	The socket file appears before the app is listening, and a stalled app lets
	the kernel accept a connection it will never read, so neither the file nor a
	successful `connect` proves anything. Only a reply does.
	"""
	last_error = "the control socket never appeared"
	while time.monotonic() < deadline:
		if not socket_path.exists():
			time.sleep(0.25)
			continue
		remaining = deadline - time.monotonic()
		client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
		client.settimeout(max(remaining, 0.1))
		try:
			client.connect(str(socket_path))
			client.sendall(json.dumps(request or {"kind": "version"}).encode() + b"\n")
			buffered = b""
			while b"\n" not in buffered:
				chunk = client.recv(4096)
				if not chunk:
					raise ConnectionError("the app closed the connection without replying")
				buffered += chunk
			return json.loads(buffered.split(b"\n", 1)[0])
		except (OSError, ConnectionError, json.JSONDecodeError) as error:
			last_error = f"{type(error).__name__}: {error}"
			time.sleep(0.25)
		finally:
			client.close()
	raise TimeoutError(last_error)


# What the workbench fetches by absolute resource path, rather than importing.
# A missing module fails loudly at startup; these fail quietly and late, in the
# one feature that needed them — which is how a nightly shipped with syntax
# highlighting entirely gone and nothing in the app to say so.
FETCHED_ASSETS = (
	"vscode-oniguruma/release/onig.wasm",
	"@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm",
)

# What the app starts as a process, rather than importing. Same silence as the
# fetched assets: search returns nothing, or a terminal never opens, and the
# window is otherwise perfectly healthy.
SPAWNED_BINARIES = (
	f"@vscode/ripgrep-universal/bin/darwin-{'arm64' if platform.machine() == 'arm64' else 'x64'}/rg",
	"node-pty/build/Release/spawn-helper",
)

# A built workbench does not fetch the assets above out of `node_modules`. It
# computes `node_modules.asar.unpacked`, because a fetch wants a real file and
# the archive is where those files are *not*. Which of the two names it compiles
# to is decided by `isBuilt`, so this is precisely the difference a source run
# cannot show you: in `pnpm dev` every one of these paths resolves either way.
UNPACKED_DIR = "node_modules.asar.unpacked"

# Under `Contents/Resources/app`, where packaging copies `apps/desktop/out`.
# The path `inputSourceHelperPath` in main/shell/inputSourceHelper.ts computes.
DEVHUB_SPAWNED_BINARY = "out/native/devhub-input-source"


# What `WorkbenchView` (apps/desktop/src/main/shell/workbenchView.ts) prints
# once a workbench's page has loaded. A fresh DevHub opens none by itself —
# every Workspace's editor area shows its terminal until `Cmd+Q E` asks for its
# VS Code editor (docs/terminal-mode.md) — so the smoke asks for Scratch's, the
# way the chord does (`devhub --tell run toggle_editor`), and a startup that
# gets this far has created a view, navigated it and survived the commit.
WORKBENCH_LOADED = re.compile(r"\[devhub\] workbench view \d+: its page has finished loading")

# What `browserWindowShim.ts` prints the moment a workbench view is made.
WORKBENCH_CREATED = re.compile(r"\[devhub\] workbench view \d+ created")

# `Cmd+Q E`, as the control socket runs it: Scratch's editor area switched
# from its terminal to its VS Code editor, which starts its workbench.
TOGGLE_EDITOR = {"kind": "tell", "command": {"verb": "run", "command": "toggle_editor"}}


def workbench_loaded(log_text: str) -> bool:
	"""Whether the app's output says a workbench view finished loading its page."""
	return WORKBENCH_LOADED.search(log_text) is not None


def workbench_created(log_text: str) -> bool:
	"""Whether the app's output says a workbench view was made at all."""
	return WORKBENCH_CREATED.search(log_text) is not None


def no_workbench_for(process: subprocess.Popen, log_path: Path, quiet: float) -> str | None:
	"""None if the app ran `quiet` seconds without making a workbench view;
	otherwise why not. No workbench is started until one is asked for: that is
	the memory the editor area's terminal default is there to save."""
	until = time.monotonic() + quiet
	while time.monotonic() < until:
		code = process.poll()
		if code is not None:
			return f"the app exited before any workbench was asked for (exit status {code})"
		try:
			if workbench_created(log_path.read_text(errors="replace")):
				return "a workbench view was made before any was asked for"
		except OSError:
			pass
		time.sleep(0.25)
	return None


def ask_for_workbench(socket_path: Path, deadline: float) -> str | None:
	"""Run `toggle_editor` until it acts (the model is ready); None once it
	has, otherwise why not."""
	last = "no reply"
	while time.monotonic() < deadline:
		try:
			reply = probe(socket_path, deadline, TOGGLE_EDITOR)
		except TimeoutError as error:
			return f"the app did not answer toggle_editor ({error})"
		data = reply.get("data")
		if reply.get("ok") and isinstance(data, dict) and data.get("ran") is True:
			return None
		last = str(reply.get("message", reply))
		time.sleep(0.5)
	return f"toggle_editor never ran: {last}"


def wait_for_workbench(
	process: subprocess.Popen, log_path: Path, deadline: float, settle: float
) -> str | None:
	"""None once a workbench has loaded and the app outlived it by `settle`
	seconds; otherwise why not.

	The settle period is there because "loaded" is said from the main process
	while the renderer is still starting the workbench, and the main process
	can still go down underneath it.
	"""
	loaded_at: float | None = None
	while True:
		now = time.monotonic()
		code = process.poll()
		if code is not None:
			stage = "after a workbench loaded" if loaded_at is not None else "before any workbench loaded"
			return f"the app exited {stage} (exit status {code}; a negative status is the signal that ended it)"
		if loaded_at is None:
			try:
				if workbench_loaded(log_path.read_text(errors="replace")):
					loaded_at = now
			except OSError:
				pass
		if loaded_at is not None and now - loaded_at >= settle:
			return None
		if now >= deadline:
			return "no workbench view finished loading in time"
		time.sleep(0.25)


def log_tail(log_path: Path, lines: int = 40) -> str:
	try:
		return "\n".join(log_path.read_text(errors="replace").splitlines()[-lines:])
	except OSError:
		return "(no output)"


def check_bundle_layout(app: Path) -> list[str]:
	"""Faults that a running app would not report, so the app cannot be asked.

	Every check below is about the same failure: a file the workbench fetches
	from a path it computes. Nothing throws when that path is wrong — the fetch
	404s inside the feature that wanted it, the feature turns itself off, and
	the app looks healthy. So the bundle is inspected instead of interrogated.
	"""
	faults = []
	code_oss = app / "Contents" / "Resources" / "app" / "node_modules" / "code-oss-dev"

	# The archive and its sidecar are a pair; neither is meaningful alone. A
	# missing sidecar in particular is silent — every module still imports, and
	# only the spawned and fetched things break.
	if not (code_oss / "node_modules.asar").is_file():
		faults.append("node_modules.asar is missing: the app has no modules to resolve")
	if not (code_oss / UNPACKED_DIR).is_dir():
		faults.append(f"{UNPACKED_DIR} is missing: nothing spawnable or fetchable survived packing")

	for asset in FETCHED_ASSETS:
		if not (code_oss / UNPACKED_DIR / asset).is_file():
			faults.append(f"the workbench fetches {asset}, and it is not in {UNPACKED_DIR}")

	# Everything the app spawns has to be a real file: Electron's asar layer is
	# in its file system, not in its process spawner, so an executable left
	# inside the archive fails with ENOTDIR at the moment the feature is used.
	for spawned in SPAWNED_BINARIES:
		path = code_oss / UNPACKED_DIR / spawned
		if not path.is_file():
			faults.append(f"the app spawns {spawned}, and it is not in {UNPACKED_DIR}")
		elif not os.access(path, os.X_OK):
			faults.append(f"the app spawns {spawned}, and it is not executable")

	# DevHub's own helper, which switches the input source while a chord is
	# armed. It lives with DevHub's code rather than in the archive, and a
	# bundle without it starts fine and says so only at the first chord.
	helper = app / "Contents" / "Resources" / "app" / DEVHUB_SPAWNED_BINARY
	if not helper.is_file():
		faults.append(f"the app spawns {DEVHUB_SPAWNED_BINARY}, and it is not in the bundle")
	elif not os.access(helper, os.X_OK):
		faults.append(f"the app spawns {DEVHUB_SPAWNED_BINARY}, and it is not executable")

	# The archive is only reachable if product.json says this is a built app,
	# and `commit` is what says it — `isBuilt = Boolean(commit)` in
	# src/vs/amdX.ts. Without it the workbench resolves vscode-textmate,
	# vscode-oniguruma and xterm out of a `node_modules` the bundle does not
	# have, and highlighting and the terminal go quietly missing. The value has
	# to be the VS Code the build was made from; DevHub's own hash answers a
	# different question and belongs in `hostCommit`.
	product_file = code_oss / "product.json"
	product = json.loads(product_file.read_text()) if product_file.is_file() else {}
	if not product.get("commit"):
		faults.append(
			"product.json states no commit: the workbench will look for its "
			"modules outside node_modules.asar"
		)
	if not product.get("hostCommit"):
		faults.append("product.json states no hostCommit: the app cannot say which DevHub it is")
	if product.get("commit") == product.get("hostCommit") and product.get("commit"):
		faults.append(
			"product.json puts DevHub's own hash in commit: that field is the "
			"VS Code the build was made from"
		)

	return faults


# The profile this test runs the app under. Anything but the default: see the
# module docstring for what the default profile does to a live DevHub.
SMOKE_PROFILE = "smoke"


def user_data_directory(state: Path) -> Path:
	"""Where the app is told to keep its editor state, and so its control socket."""
	return state / "editor"


def launch_command(
	executable: Path,
	state: Path,
	base_environment: dict[str, str] | None = None,
) -> tuple[list[str], dict[str, str]]:
	"""How to start the bundle so that it owns nothing a live DevHub owns.

	Three locations have to move together, and each moves by its own mechanism:
	the editor's user-data directory (and the control socket inside it) by the
	command line, the config directory by `XDG_CONFIG_HOME`, and the tmux socket
	by the profile name — `profile.ts` derives `devhub-smoke` from it. Returned
	rather than passed straight to Popen so a test can assert all three without
	starting Electron.
	"""
	environment = dict(os.environ if base_environment is None else base_environment)
	environment["DEVHUB_PROFILE"] = SMOKE_PROFILE
	environment["XDG_CONFIG_HOME"] = str(state / "config")
	argv = [
		str(executable),
		"--user-data-dir",
		str(user_data_directory(state)),
		"--extensions-dir",
		str(state / "extensions"),
	]
	return argv, environment


def source_launch_command(
	repo: Path,
	state: Path,
	electron_args: list[str] | None = None,
	base_environment: dict[str, str] | None = None,
) -> tuple[list[str], dict[str, str]]:
	"""How to start a source run so that it owns nothing a live DevHub owns.

	`dev.sh` derives the editor's directories from the profile and HOME rather
	than taking them on the command line, so HOME moves into the throwaway state
	along with the config directory, and the profile is `smoke` as for a
	bundle; the tmux socket directory moves too, so the server the app starts
	can be ended with it. `dev.sh` would otherwise try to build a remote
	extension host first.
	"""
	environment = dict(os.environ if base_environment is None else base_environment)
	environment["DEVHUB_PROFILE"] = SMOKE_PROFILE
	environment["XDG_CONFIG_HOME"] = str(state / "config")
	environment["HOME"] = str(state / "home")
	environment["DEVHUB_SKIP_REH_BUILD"] = "1"
	environment["TMUX_TMPDIR"] = str(state / "tmux")
	argv = [str(repo / "apps" / "desktop" / "scripts" / "dev.sh"), *(electron_args or [])]
	return argv, environment


def source_electron(repo: Path) -> Path:
	"""The Electron `dev.sh` boots, as it names it."""
	if sys.platform == "darwin":
		return repo / "vscode" / ".build" / "devhub-electron" / "DevHub.app" / "Contents" / "MacOS" / "DevHub"
	return repo / "vscode" / ".build" / "electron" / "code-oss"


def source_user_data_directory(repo: Path, environment: dict[str, str]) -> Path:
	"""Where a source run under `environment` keeps its editor state.

	Asked of `out/main/profilePaths.js`, the derivation `dev.sh` itself evals,
	rather than spelled a second time here.
	"""
	output = subprocess.run(
		[str(source_electron(repo)), str(repo / "apps" / "desktop" / "out" / "main" / "profilePaths.js")],
		env={**environment, "ELECTRON_RUN_AS_NODE": "1"},
		check=True,
		capture_output=True,
		text=True,
	).stdout
	for line in output.splitlines():
		name, _, value = line.partition("=")
		if name == "DEVHUB_USER_DATA_DIR":
			return Path(value.strip("'"))
	raise RuntimeError(f"profilePaths.js named no DEVHUB_USER_DATA_DIR:\n{output}")


def smoke_source(repo: Path, timeout: float, settle: float, electron_args: list[str]) -> int:
	if not source_electron(repo).is_file():
		print(f"no Electron at {source_electron(repo)}: run scripts/provision-vscode.sh", file=sys.stderr)
		return 1
	if not (repo / "apps" / "desktop" / "out" / "main" / "main.js").is_file():
		print("apps/desktop is not built: run 'pnpm --filter @devhub/desktop build'", file=sys.stderr)
		return 1
	state = Path(tempfile.mkdtemp(prefix="devhub-smoke-"))
	argv, environment = source_launch_command(repo, state, electron_args)
	for directory in ("HOME", "XDG_CONFIG_HOME", "TMUX_TMPDIR"):
		Path(environment[directory]).mkdir(parents=True, exist_ok=True)
	user_data = source_user_data_directory(repo, environment)
	print(f"    a source run (apps/desktop/scripts/dev.sh) under the {SMOKE_PROFILE} profile")
	return run_and_probe(argv, environment, state, user_data, timeout, settle)


def smoke(app: Path, timeout: float, settle: float = 5.0) -> int:
	executable = app / "Contents" / "MacOS" / "DevHub"
	if not executable.is_file():
		print(f"not a DevHub bundle: {executable} does not exist", file=sys.stderr)
		return 1

	faults = check_bundle_layout(app)
	if faults:
		for fault in faults:
			print(f"    {fault}", file=sys.stderr)
		return 1
	print(
		f"    the archive is paired with its sidecar, and everything the app "
		f"fetches or spawns is in it ({len(FETCHED_ASSETS) + len(SPAWNED_BINARIES) + 1} checked)"
	)

	state = Path(tempfile.mkdtemp(prefix="devhub-smoke-"))
	argv, environment = launch_command(executable, state)
	return run_and_probe(argv, environment, state, user_data_directory(state), timeout, settle)


def run_and_probe(
	argv: list[str],
	environment: dict[str, str],
	state: Path,
	user_data: Path,
	timeout: float,
	settle: float,
	quiet: float = 5.0,
) -> int:
	"""Start the app, require a reply on its control socket, no workbench
	until one is asked for, and then a workbench it outlives — and take it
	and its state down again whatever happened."""
	# A file rather than a pipe: nothing reads a pipe while the app runs, and
	# an app that fills one blocks on its own console.log.
	log_path = state / "app.log"
	log = log_path.open("w")
	process = subprocess.Popen(
		argv,
		env=environment,
		stdout=log,
		stderr=subprocess.STDOUT,
		text=True,
		start_new_session=True,
	)
	log.close()
	try:
		started = time.monotonic()
		try:
			reply = probe(user_data / "devhub" / "control.sock", started + timeout)
		except TimeoutError as error:
			print(f"    the app never answered within {timeout:.0f}s ({error})", file=sys.stderr)
			print(
				"    the main process is up but its event loop is not running:\n"
				"    the packaged app answers no IPC at all in this state.",
				file=sys.stderr,
			)
			print(log_tail(log_path), file=sys.stderr)
			return 1
		if not reply.get("ok"):
			print(f"    the app answered, but with a failure: {reply}", file=sys.stderr)
			return 1
		first_line = str(reply.get("message", "")).splitlines()[0:1]
		print(f"    the control socket answered: {first_line[0] if first_line else reply}")

		problem = no_workbench_for(process, log_path, quiet)
		if problem is not None:
			print(f"    {problem}", file=sys.stderr)
			print(log_tail(log_path), file=sys.stderr)
			return 1
		print(f"    no workbench was started in the first {quiet:.0f}s, before one was asked for")
		problem = ask_for_workbench(user_data / "devhub" / "control.sock", started + timeout)
		if problem is not None:
			print(f"    {problem}", file=sys.stderr)
			print(log_tail(log_path), file=sys.stderr)
			return 1
		print("    toggle_editor ran: Scratch's editor area asked for its VS Code editor")
		problem = wait_for_workbench(process, log_path, time.monotonic() + timeout, settle)
		if problem is not None:
			print(f"    {problem}", file=sys.stderr)
			print(log_tail(log_path), file=sys.stderr)
			return 1
		print(f"    a workbench view loaded, and the app was still running {settle:.0f}s later")
		return 0
	finally:
		# A stalled app cannot run its own SIGTERM handler — that needs the very
		# event loop that is gone — so there is nothing gentler than SIGKILL to
		# end it with, and the whole session goes so no child outlives the test.
		try:
			os.killpg(process.pid, signal.SIGKILL)
		except ProcessLookupError:
			pass
		process.wait(timeout=30)
		# tmux daemonizes out of the session, so a server the app started is
		# ended by name, on the socket directory the run was given.
		if "TMUX_TMPDIR" in environment and shutil.which("tmux"):
			subprocess.run(
				["tmux", "-L", f"devhub-{SMOKE_PROFILE}", "kill-server"],
				env=environment,
				capture_output=True,
			)
		shutil.rmtree(state, ignore_errors=True)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("app", type=Path, nargs="?", help="the DevHub.app bundle to start")
	parser.add_argument(
		"--source",
		action="store_true",
		help="start this checkout's source run (apps/desktop/scripts/dev.sh) instead of a bundle",
	)
	parser.add_argument(
		"--electron-arg",
		action="append",
		default=[],
		help="an extra argument for a source run's Electron (repeatable), e.g. --no-sandbox",
	)
	parser.add_argument(
		"--timeout",
		type=float,
		default=90.0,
		help="how long to wait for a reply before calling it stalled",
	)
	parser.add_argument(
		"--settle",
		type=float,
		default=5.0,
		help="how long the app must keep running after a workbench view has loaded",
	)
	args = parser.parse_args()
	if args.source:
		if args.app is not None:
			parser.error("--source starts this checkout; it takes no bundle")
		repo = Path(__file__).resolve().parent.parent
		return smoke_source(repo, args.timeout, args.settle, args.electron_arg)
	if args.app is None:
		parser.error("name a DevHub.app bundle, or pass --source")
	if args.electron_arg:
		parser.error("--electron-arg is for --source")
	return smoke(args.app.resolve(), args.timeout, args.settle)


if __name__ == "__main__":
	raise SystemExit(main())
