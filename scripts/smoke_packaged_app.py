#!/usr/bin/env python3
"""Launch DevHub and make it answer on its control socket, then open a file.

A packaged app can look completely healthy and still be useless: its main
thread parked inside a synchronous macOS call, Electron no longer pumping libuv
behind it, timers and sockets silent, the `devhub` command hanging forever.
Nothing about the bundle's contents says so, so the only way to know is to
start the app and ask it something.

That is what this does: it starts DevHub against throwaway state, sends the
`version` request the `devhub` CLI sends and requires a reply, then opens a
file the way `devhub <file>` does — which starts Scratch's Neovim and drops
the file into it — requires that reply too, and requires the app to still be
running `--settle` seconds later.

It also reads a bundle before starting it, for the faults a reply cannot rule
out: a dependency, a native helper, the libghostty wasm or the Neovim missing
from `Resources/app` takes one feature down and leaves the rest of the app
answering. See `check_app_layout`; `exercise_neovim` runs the bundled Neovim
and asks it its version and its runtime, and `exercise_tmux` the bundled tmux
its version. Once the file is open, `check_tmux_server` asks the tmux server
the app started whether it is that tmux — the executable, not one from the
PATH — and whether its panes find it first on theirs.

It starts the app under its own profile, `smoke`, and that is not a detail. A
DevHub launched on the *default* profile is the user's DevHub: it reads
`~/.config/devhub`, it attaches to the tmux socket `devhub`, and on startup it
reaps every DevHub-marked Agent session its own state file does not know
about. `smoke` keeps the test off all of it — the profile name derives the tmux
socket (`devhub-smoke`) and the data directories — and `XDG_CONFIG_HOME` and
HOME under the same throwaway directory move the rest. See
apps/desktop/src/model/profile.ts.

    scripts/smoke_packaged_app.py path/to/DevHub.app      a macOS bundle
    scripts/smoke_packaged_app.py --layout DIR            a `Resources/app`
                                                          laid out by
                                                          package-nightly.py
                                                          --layout-only, run by
                                                          npm's Electron (Linux)
    scripts/smoke_packaged_app.py --source                this checkout (dev.sh)

`--electron-arg=--no-sandbox` passes an argument to Electron (`--layout`,
`--source`).
"""

from __future__ import annotations

import argparse
import hashlib
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


def probe(socket_path: Path, deadline: float) -> dict:
	"""Ask the running app for its version, or raise once the deadline passes.

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
			client.sendall(json.dumps({"kind": "version"}).encode() + b"\n")
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


def outlives(process: subprocess.Popen, settle: float) -> str | None:
	"""None once the app has kept running `settle` seconds; otherwise why not."""
	until = time.monotonic() + settle
	while time.monotonic() < until:
		code = process.poll()
		if code is not None:
			return f"the app exited after opening the file (exit status {code}; a negative status is the signal that ended it)"
		time.sleep(0.25)
	return None


def log_tail(log_path: Path, lines: int = 40) -> str:
	try:
		return "\n".join(log_path.read_text(errors="replace").splitlines()[-lines:])
	except OSError:
		return "(no output)"


def check_app_layout(app_dir: Path, platform_name: str) -> list[str]:
	"""Faults in `Resources/app` that a running app would not report.

	`platform_name` is node-pty's prebuild directory: `darwin-arm64`,
	`linux-x64`.
	"""
	faults = []
	manifest = app_dir / "package.json"
	if not manifest.is_file():
		return [f"{manifest} is missing: Electron has nothing to load"]
	main = app_dir / json.loads(manifest.read_text()).get("main", "")
	if not main.is_file():
		faults.append(f"package.json's main, {main}, is missing")
	for required in ("out/vt/ghostty-vt.wasm", "dist/shell/index.html"):
		if not (app_dir / required).is_file():
			faults.append(f"{required} is missing")
	faults.extend(cli_faults(app_dir))
	prebuild = app_dir / "node_modules" / "node-pty" / "prebuilds" / platform_name
	if not (prebuild / "pty.node").is_file():
		faults.append(f"node-pty has no prebuild for {platform_name}: no terminal can start")
	if platform_name.startswith("darwin"):
		helper = prebuild / "spawn-helper"
		if not os.access(helper, os.X_OK):
			faults.append("node-pty's spawn-helper is missing or not executable: no terminal can start")
		input_source = app_dir / "out" / "native" / "devhub-input-source"
		if not os.access(input_source, os.X_OK):
			faults.append("out/native/devhub-input-source is missing or not executable")
	nvim = app_dir / "out" / "nvim" / "bin" / "nvim"
	if not os.access(nvim, os.X_OK):
		faults.append("out/nvim/bin/nvim is missing or not executable: no editor can start")
	if not (app_dir / "out" / "nvim" / "share" / "nvim" / "runtime").is_dir():
		faults.append("out/nvim/share/nvim/runtime is missing: Neovim has no runtime")
	if not os.access(app_dir / "out" / "bash" / "bin" / "bash", os.X_OK):
		faults.append("out/bash/bin/bash is missing or not executable: no Claude Agent can start")
	tmux = bundled_tmux(app_dir)
	if not os.access(tmux, os.X_OK):
		faults.append("out/tmux/bin/tmux is missing or not executable: no terminal can start")
	if not (app_dir / "out" / "tmux" / "terminfo").is_dir():
		faults.append("out/tmux/terminfo is missing: the bundled tmux's build is incomplete")
	product_file = app_dir / "product.json"
	product = json.loads(product_file.read_text()) if product_file.is_file() else {}
	if not product.get("commit"):
		faults.append("product.json states no commit: the app cannot say which DevHub it is")
	return faults


# The `devhub` command (cli/, Go, docs/devhub-cli.md): this Mac's, and the
# ones a host is given from the app (BundledToolDelivery).
CLI_PLATFORMS = ("darwin-arm64", "linux-x64", "linux-arm64")


def cli_binary(app_dir: Path, platform_name: str) -> Path:
	return app_dir / "out" / "cli" / platform_name / "devhub"


def cli_faults(app_dir: Path) -> list[str]:
	"""Every platform's `devhub` there, executable, and matching SHA256SUMS."""
	sums_file = app_dir / "out" / "cli" / "SHA256SUMS"
	if not sums_file.is_file():
		return ["out/cli/SHA256SUMS is missing: no host can be given a devhub command"]
	sums = {}
	for line in sums_file.read_text().splitlines():
		digest, _, name = line.partition("  ")
		sums[name] = digest
	faults = []
	for name in CLI_PLATFORMS:
		binary = cli_binary(app_dir, name)
		if not os.access(binary, os.X_OK):
			faults.append(f"out/cli/{name}/devhub is missing or not executable")
		elif sums.get(f"{name}/devhub") != hashlib.sha256(binary.read_bytes()).hexdigest():
			faults.append(f"out/cli/{name}/devhub does not match SHA256SUMS")
	return faults


def run_cli(cli: Path, socket_path: Path, args: list[str], cwd: Path, timeout: float) -> subprocess.CompletedProcess:
	"""The packed `devhub`, the way the installed launcher runs it."""
	return subprocess.run(
		[str(cli), *args],
		env={
			"PATH": "/usr/bin:/bin",
			"HOME": str(cwd),
			"DEVHUB_CONTROL_SOCKET": str(socket_path),
			"DEVHUB_LAUNCH_COMMAND": '["/bin/false"]',
		},
		cwd=cwd,
		capture_output=True,
		text=True,
		timeout=timeout,
	)


# What `check_app_layout` cannot see: whether the packed node-pty loads and
# drives a PTY, and whether the packed wasm instantiates — asked of the app's
# own Electron, run as Node, against the packed tree and nothing else.
EXERCISE = """
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const root = process.argv[2];
const require = createRequire(root + "/out/main/main.js");
const where = require.resolve("node-pty");
if (!where.startsWith(root + "/node_modules/")) throw new Error("node-pty resolved outside the app: " + where);
const { nodePty } = await import(root + "/out/main/terminal/pty.js");
const output = await new Promise((resolve, reject) => {
	const pty = nodePty().spawn("/bin/sh", ["-c", "echo pty-ok"], { cols: 80, rows: 24, env: process.env });
	let seen = "";
	pty.onData((data) => { seen += data; });
	pty.onExit(() => resolve(seen));
	setTimeout(() => reject(new Error("the PTY never exited")), 10000);
});
if (!output.includes("pty-ok")) throw new Error("the PTY printed " + JSON.stringify(output));
const { LibGhosttyVt } = await import(root + "/out/main/ptyHost/vt/libghosttyVt.js");
const vt = await LibGhosttyVt.load(readFileSync(root + "/out/vt/ghostty-vt.wasm"));
console.log("node-pty from " + where.slice(root.length + 1) + " ran a PTY; libghostty-vt " + vt.version + " instantiated");
"""


# What the bundled Neovim answers when run as DevHub runs it: no config, no
# inherited runtime. It must be the pinned release, finding its runtime
# beside itself, inside the app.
NEOVIM_QUESTION = "lua local v = vim.version(); io.stdout:write(v.major .. '.' .. v.minor .. '.' .. v.patch .. '\\n' .. vim.env.VIMRUNTIME .. '\\n')"


def exercise_neovim(app_dir: Path) -> str | None:
	"""Run `out/nvim/bin/nvim` headless; None, or what was wrong."""
	nvim = app_dir / "out" / "nvim" / "bin" / "nvim"
	pinned = json.loads((app_dir / "product.json").read_text()).get("nvimVersion")
	environment = {key: value for key, value in os.environ.items() if key not in ("VIMRUNTIME", "VIM")}
	try:
		result = subprocess.run(
			[str(nvim), "--headless", "--clean", "-c", NEOVIM_QUESTION, "-c", "qa!"],
			env=environment,
			stdin=subprocess.DEVNULL,
			capture_output=True,
			text=True,
			timeout=30,
		)
	except (OSError, subprocess.TimeoutExpired) as error:
		return f"the bundled Neovim did not run: {error}"
	lines = result.stdout.split()
	if result.returncode != 0 or len(lines) != 2:
		return f"the bundled Neovim did not answer (exit {result.returncode}): {(result.stderr or result.stdout).strip()}"
	version, runtime = lines
	if version != pinned:
		return f"the bundled Neovim is {version}, and product.json pins {pinned}"
	if not Path(runtime).resolve().is_relative_to((app_dir / "out" / "nvim").resolve()):
		return f"the bundled Neovim's runtime is {runtime}, outside the app"
	print(f"    the bundled Neovim {version} ran, its runtime {runtime}")
	return None


def exercise_bash(app_dir: Path) -> str | None:
	"""Run `out/bash/bin/bash -c` with nothing inherited; None, or what was wrong.

	The shell every Claude Agent runs in (`docs/bundled-binaries.md`): it must
	be the pinned bash, and run from inside the app with no PATH at all."""
	bash = app_dir / "out" / "bash" / "bin" / "bash"
	pinned = json.loads((app_dir / "product.json").read_text()).get("bashVersion")
	try:
		result = subprocess.run(
			[str(bash), "--norc", "--noprofile", "-c", 'printf %s "$BASH_VERSION"'],
			env={},
			stdin=subprocess.DEVNULL,
			capture_output=True,
			text=True,
			timeout=30,
		)
	except (OSError, subprocess.TimeoutExpired) as error:
		return f"the bundled bash did not run: {error}"
	if result.returncode != 0 or not result.stdout.startswith(f"{pinned}("):
		return f"the bundled bash answered {result.stdout!r} (exit {result.returncode}); product.json pins {pinned}"
	print(f"    the bundled bash {result.stdout} ran")
	return None


def bundled_tmux(app_dir: Path) -> Path:
	"""The tmux inside the app (`out/tmux`, `main/terminal/bundledTmux.ts`)."""
	return app_dir / "out" / "tmux" / "bin" / "tmux"


def exercise_tmux(app_dir: Path) -> str | None:
	"""Run `out/tmux/bin/tmux -V`; None, or what was wrong."""
	pinned = json.loads((app_dir / "product.json").read_text()).get("tmuxVersion")
	try:
		result = subprocess.run(
			[str(bundled_tmux(app_dir)), "-V"], capture_output=True, text=True, timeout=30
		)
	except (OSError, subprocess.TimeoutExpired) as error:
		return f"the bundled tmux did not run: {error}"
	if result.returncode != 0 or result.stdout.strip() != f"tmux {pinned}":
		return f"the bundled tmux answered {result.stdout.strip() or result.stderr.strip()!r}, and product.json pins tmux {pinned}"
	print(f"    the bundled {result.stdout.strip()} ran")
	return None


def server_executable(pid: int) -> Path | None:
	"""The program a process runs, as the kernel says (Linux) or `ps` (macOS)."""
	if sys.platform == "linux":
		try:
			return Path(os.readlink(f"/proc/{pid}/exe"))
		except OSError:
			return None
	result = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True)
	return Path(result.stdout.strip()) if result.returncode == 0 and result.stdout.strip() else None


def check_tmux_server(tmux: Path, environment: dict[str, str]) -> str | None:
	"""The app's tmux server is the bundled tmux, and its panes' `tmux` is too.

	Asked of the server on the smoke profile's socket: its version, the
	program its process runs, and the `tmux` first on the PATH it gives a
	pane — DevHub's pane shim, which runs the bundled tmux by its path.
	"""
	socket_name = f"devhub-{SMOKE_PROFILE}"
	asked = subprocess.run(
		[str(tmux), "-L", socket_name, "display-message", "-p", "#{version} #{pid}"],
		env=environment,
		capture_output=True,
		text=True,
		timeout=30,
	)
	if asked.returncode != 0:
		return f"the app's tmux server did not answer on {socket_name}: {asked.stderr.strip()}"
	version, _, pid = asked.stdout.strip().partition(" ")
	program = server_executable(int(pid)) if pid.isdigit() else None
	if program is None or program.resolve() != tmux.resolve():
		return f"the app's tmux server (tmux {version}, pid {pid}) runs {program}, not the bundled {tmux}"
	path = subprocess.run(
		[str(tmux), "-L", socket_name, "show-environment", "-g", "PATH"],
		env=environment,
		capture_output=True,
		text=True,
		timeout=30,
	).stdout.strip()
	first = Path(path.removeprefix("PATH=").split(":")[0]) / "tmux"
	try:
		shim = first.read_text()
	except OSError as error:
		return f"a pane's PATH starts {path.removeprefix('PATH=').split(':')[0]}, with no DevHub tmux in it ({error})"
	if str(tmux) not in shim:
		return f"the tmux first on a pane's PATH ({first}) is not the bundled one:\n{shim}"
	print(f"    the app's tmux server is the bundled tmux {version}, and a pane's `tmux` ({first}) runs it")
	return None


def exercise_app(electron: Path, app_dir: Path) -> str | None:
	"""Run `EXERCISE` in `electron` as Node; None, or what failed."""
	with tempfile.TemporaryDirectory(prefix="devhub-exercise-") as scratch:
		script = Path(scratch) / "exercise.mjs"
		script.write_text(EXERCISE)
		result = subprocess.run(
			[str(electron), str(script), str(app_dir)],
			env={**os.environ, "ELECTRON_RUN_AS_NODE": "1", "NODE_OPTIONS": ""},
			capture_output=True,
			text=True,
			timeout=60,
		)
	if result.returncode != 0:
		return (result.stderr or result.stdout).strip()
	print(f"    {result.stdout.strip()}")
	return None


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
	]
	return argv, environment


def source_launch_command(
	repo: Path,
	state: Path,
	electron_args: list[str] | None = None,
	base_environment: dict[str, str] | None = None,
) -> tuple[list[str], dict[str, str]]:
	"""How to start a source run so that it owns nothing a live DevHub owns.

	`dev.sh` derives the user-data directory from the profile and HOME rather
	than taking it on the command line, so HOME moves into the throwaway state
	along with the config directory, and the profile is `smoke` as for a
	bundle; the tmux socket directory moves too, so the server the app starts
	can be ended with it.
	"""
	environment = dict(os.environ if base_environment is None else base_environment)
	environment["DEVHUB_PROFILE"] = SMOKE_PROFILE
	environment["XDG_CONFIG_HOME"] = str(state / "config")
	environment["HOME"] = str(state / "home")
	environment["TMUX_TMPDIR"] = str(state / "tmux")
	argv = [str(repo / "apps" / "desktop" / "scripts" / "dev.sh"), *(electron_args or [])]
	return argv, environment


def source_electron(repo: Path) -> Path:
	"""npm's Electron, as apps/desktop/scripts/electron-path.sh names it."""
	return Path(
		subprocess.run(
			[str(repo / "apps" / "desktop" / "scripts" / "electron-path.sh")],
			check=True,
			capture_output=True,
			text=True,
		).stdout.strip()
	)


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
	if not (repo / "apps" / "desktop" / "out" / "main" / "main.js").is_file():
		print("apps/desktop is not built: run 'pnpm --filter @devhub/desktop build'", file=sys.stderr)
		return 1
	state = Path(tempfile.mkdtemp(prefix="devhub-smoke-"))
	argv, environment = source_launch_command(repo, state, electron_args)
	for directory in ("HOME", "XDG_CONFIG_HOME", "TMUX_TMPDIR"):
		Path(environment[directory]).mkdir(parents=True, exist_ok=True)
	user_data = source_user_data_directory(repo, environment)
	print(f"    a source run (apps/desktop/scripts/dev.sh) under the {SMOKE_PROFILE} profile")
	cli = cli_binary(repo / "apps" / "desktop", host_platform())
	return run_and_probe(cli, argv, environment, state, user_data, timeout, settle, bundled_tmux(repo / "apps" / "desktop"))


def host_platform() -> str:
	"""This machine as DevHub names a platform: `darwin-arm64`, `linux-x64`."""
	arch = "arm64" if platform.machine() in ("arm64", "aarch64") else "x64"
	return f"{sys.platform}-{arch}"


def smoke(app: Path, timeout: float, settle: float = 5.0) -> int:
	executable = app / "Contents" / "MacOS" / "DevHub"
	if not executable.is_file():
		print(f"not a DevHub bundle: {executable} does not exist", file=sys.stderr)
		return 1
	arch = "arm64" if platform.machine() == "arm64" else "x64"
	faults = check_app_layout(app / "Contents" / "Resources" / "app", f"darwin-{arch}")
	if faults:
		for fault in faults:
			print(f"    {fault}", file=sys.stderr)
		return 1
	print("    Resources/app has its entry, its dependencies, its helpers, its wasm, its Neovim, its bash and its tmux")
	app_dir = app / "Contents" / "Resources" / "app"
	problem = exercise_neovim(app_dir) or exercise_bash(app_dir) or exercise_tmux(app_dir)
	if problem is not None:
		print(f"    {problem}", file=sys.stderr)
		return 1
	state = Path(tempfile.mkdtemp(prefix="devhub-smoke-"))
	argv, environment = launch_command(executable, state)
	cli = cli_binary(app / "Contents" / "Resources" / "app", host_platform())
	tmux = bundled_tmux(app / "Contents" / "Resources" / "app")
	return run_and_probe(cli, argv, environment, state, user_data_directory(state), timeout, settle, tmux)


def smoke_layout(repo: Path, app_dir: Path, timeout: float, settle: float, electron_args: list[str]) -> int:
	"""A `Resources/app` laid out by `package-nightly.py --layout-only`, run by
	npm's Electron: the packaged app's tree, on any platform."""
	arch = "arm64" if platform.machine() in ("arm64", "aarch64") else "x64"
	faults = check_app_layout(app_dir, f"{sys.platform}-{arch}")
	if faults:
		for fault in faults:
			print(f"    {fault}", file=sys.stderr)
		return 1
	print("    the layout has its entry, its dependencies, its wasm, its Neovim, its bash and its tmux")
	problem = exercise_neovim(app_dir) or exercise_bash(app_dir) or exercise_tmux(app_dir)
	if problem is not None:
		print(f"    {problem}", file=sys.stderr)
		return 1
	electron = source_electron(repo)
	problem = exercise_app(electron, app_dir)
	if problem is not None:
		print(f"    {problem}", file=sys.stderr)
		return 1
	state = Path(tempfile.mkdtemp(prefix="devhub-smoke-"))
	argv, environment = launch_command(electron, state)
	argv = [argv[0], str(app_dir), *argv[1:], *electron_args]
	environment["HOME"] = str(state / "home")
	environment["TMUX_TMPDIR"] = str(state / "tmux")
	for directory in ("HOME", "XDG_CONFIG_HOME", "TMUX_TMPDIR"):
		Path(environment[directory]).mkdir(parents=True, exist_ok=True)
	print(f"    {app_dir} under npm's Electron, the {SMOKE_PROFILE} profile")
	cli = cli_binary(app_dir, host_platform())
	return run_and_probe(cli, argv, environment, state, user_data_directory(state), timeout, settle, bundled_tmux(app_dir))


def run_and_probe(
	cli: Path,
	argv: list[str],
	environment: dict[str, str],
	state: Path,
	user_data: Path,
	timeout: float,
	settle: float,
	tmux: Path,
) -> int:
	"""Start the app, require a reply on its control socket, an opened file it
	outlives and a tmux server that is its own, and take it and its state down
	again whatever happened."""
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

		socket_path = user_data / "devhub" / "control.sock"
		remaining = max(started + timeout - time.monotonic(), 10.0)
		version = run_cli(cli, socket_path, ["--version"], state, remaining)
		if version.returncode != 0 or version.stdout.strip() != str(reply.get("message", "")).strip():
			print(f"    devhub --version: status {version.returncode}, {version.stdout!r} {version.stderr!r}", file=sys.stderr)
			return 1
		print(f"    {cli.relative_to(cli.parents[3])} --version answered the same")
		(state / "smoke.txt").write_text("DevHub smoke test\n")
		opened = run_cli(cli, socket_path, ["smoke.txt"], state, max(started + timeout - time.monotonic(), 10.0))
		if opened.returncode != 0:
			print(f"    devhub smoke.txt failed ({opened.returncode}): {opened.stderr.strip()}", file=sys.stderr)
			print(log_tail(log_path), file=sys.stderr)
			return 1
		print(f"    devhub smoke.txt opened it: {opened.stdout.strip()}")
		problem = check_tmux_server(tmux, environment)
		if problem is not None:
			print(f"    {problem}", file=sys.stderr)
			print(log_tail(log_path), file=sys.stderr)
			return 1
		problem = outlives(process, settle)
		if problem is not None:
			print(f"    {problem}", file=sys.stderr)
			print(log_tail(log_path), file=sys.stderr)
			return 1
		print(f"    and the app was still running {settle:.0f}s later")
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
		# ended by name, with the app's own tmux, on the socket directory the
		# run was given.
		if os.access(tmux, os.X_OK):
			subprocess.run(
				[str(tmux), "-L", f"devhub-{SMOKE_PROFILE}", "kill-server"],
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
		"--layout",
		type=Path,
		help="start a Resources/app laid out by package-nightly.py --layout-only, with npm's Electron",
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
		help="how long the app must keep running after the file has opened",
	)
	args = parser.parse_args()
	repo = Path(__file__).resolve().parent.parent
	if args.layout is not None:
		return smoke_layout(repo, args.layout.resolve(), args.timeout, args.settle, args.electron_arg)
	if args.source:
		if args.app is not None:
			parser.error("--source starts this checkout; it takes no bundle")
		return smoke_source(repo, args.timeout, args.settle, args.electron_arg)
	if args.app is None:
		parser.error("name a DevHub.app bundle, or pass --source")
	if args.electron_arg:
		parser.error("--electron-arg is for --source and --layout")
	return smoke(args.app.resolve(), args.timeout, args.settle)


if __name__ == "__main__":
	raise SystemExit(main())
