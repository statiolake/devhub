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

It also reads the bundle before starting it, for the faults a reply cannot
rule out. An asset the workbench fetches by path — a wasm file, say — going
missing takes one feature down and leaves the rest of the app answering
normally, so no question asked of a running DevHub would ever find it. See
`check_bundle_layout`.

Run it standalone against any bundle:

    scripts/smoke_packaged_app.py path/to/DevHub.app
"""

from __future__ import annotations

import argparse
import json
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


# What the workbench fetches by absolute resource path, rather than importing.
# A missing module fails loudly at startup; these fail quietly and late, in the
# one feature that needed them — which is how a nightly shipped with syntax
# highlighting entirely gone and nothing in the app to say so.
FETCHED_ASSETS = (
	"vscode-oniguruma/release/onig.wasm",
	"@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm",
)

# The resource path of an `app.asar` archive's contents, as `nodeModulesPath`
# and its two deleted siblings compile to. DevHub ships no archive — see
# patches/vscode/0002-no-node-modules-asar.patch, and "Nothing here is an
# `app.asar` either" in package-nightly.py — so any code that builds this path
# is asking for a file that cannot exist, and will 404 in the packaged app
# while working perfectly in a source run.
ARCHIVE_RESOURCE_PATH = "vs/../../node_modules.asar"


def check_bundle_layout(app: Path) -> list[str]:
	"""Faults that a running app would not report, so the app cannot be asked.

	Both checks below are about the same failure: a file the workbench fetches
	from a path it computes. Nothing throws when that path is wrong — the fetch
	404s inside the feature that wanted it, the feature turns itself off, and
	the app looks healthy. So the bundle is inspected instead of interrogated.
	"""
	faults = []
	code_oss = app / "Contents" / "Resources" / "app" / "node_modules" / "code-oss-dev"

	for asset in FETCHED_ASSETS:
		if not (code_oss / "node_modules" / asset).is_file():
			faults.append(f"the workbench fetches {asset}, and it is not in the bundle")

	offenders = sorted(
		path.relative_to(code_oss).as_posix()
		for path in (code_oss / "out").rglob("*.js")
		if ARCHIVE_RESOURCE_PATH in path.read_text(errors="replace")
	)
	for offender in offenders:
		faults.append(f"{offender} resolves resources inside an asar archive DevHub does not ship")

	return faults


def smoke(app: Path, timeout: float) -> int:
	executable = app / "Contents" / "MacOS" / "DevHub"
	if not executable.is_file():
		print(f"not a DevHub bundle: {executable} does not exist", file=sys.stderr)
		return 1

	faults = check_bundle_layout(app)
	if faults:
		for fault in faults:
			print(f"    {fault}", file=sys.stderr)
		return 1
	print(f"    the fetched assets are all present ({len(FETCHED_ASSETS)} checked)")

	state = Path(tempfile.mkdtemp(prefix="devhub-smoke-"))
	user_data = state / "editor"
	process = subprocess.Popen(
		[
			str(executable),
			"--user-data-dir",
			str(user_data),
			"--extensions-dir",
			str(state / "extensions"),
		],
		stdout=subprocess.PIPE,
		stderr=subprocess.STDOUT,
		text=True,
		start_new_session=True,
	)
	try:
		reply = probe(user_data / "devhub" / "control.sock", time.monotonic() + timeout)
	except TimeoutError as error:
		print(f"    the app never answered within {timeout:.0f}s ({error})", file=sys.stderr)
		print(
			"    the main process is up but its event loop is not running:\n"
			"    the packaged app answers no IPC at all in this state.",
			file=sys.stderr,
		)
		return 1
	finally:
		# A stalled app cannot run its own SIGTERM handler — that needs the very
		# event loop that is gone — so there is nothing gentler than SIGKILL to
		# end it with, and the whole session goes so no child outlives the test.
		try:
			process.send_signal(signal.SIGKILL)
		except ProcessLookupError:
			pass
		process.wait(timeout=30)
		shutil.rmtree(state, ignore_errors=True)

	if not reply.get("ok"):
		print(f"    the app answered, but with a failure: {reply}", file=sys.stderr)
		return 1
	first_line = str(reply.get("message", "")).splitlines()[0:1]
	print(f"    the control socket answered: {first_line[0] if first_line else reply}")
	return 0


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("app", type=Path, help="the DevHub.app bundle to start")
	parser.add_argument(
		"--timeout",
		type=float,
		default=90.0,
		help="how long to wait for a reply before calling it stalled",
	)
	args = parser.parse_args()
	return smoke(args.app.resolve(), args.timeout)


if __name__ == "__main__":
	raise SystemExit(main())
