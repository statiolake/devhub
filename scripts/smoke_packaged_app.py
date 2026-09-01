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


def smoke(app: Path, timeout: float) -> int:
	executable = app / "Contents" / "MacOS" / "DevHub"
	if not executable.is_file():
		print(f"not a DevHub bundle: {executable} does not exist", file=sys.stderr)
		return 1

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
