#!/usr/bin/env python3
"""Make sure a source run has the one remote extension host this Mac can build
and test with: the glibc server of its own CPU.

`pnpm dev` calls this before it starts the app (apps/desktop/scripts/dev.sh).
Apple Silicon wants `linux-arm64`, an Intel Mac `linux-x64`; those run in
Docker natively, so building them is the ~15 minute case. The musl servers and
the other architecture are emulated and slower, so they are never built here —
dev.sh only lists them (see docs/remote-ssh.md).

Nothing in here may stop the app from starting. A server that is present and
current is a file check, with no Docker call. A missing Docker, a failed build
and an opt-out (`DEVHUB_SKIP_REH_BUILD=1`) each end in a message and exit 0.
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
from pathlib import Path

from build_reh import DEFAULT_OUT_DIR, REPO_ROOT, bundle_problems, docker_available
from product_metadata import reh_identity, vscode_commit

SKIP_ENV = "DEVHUB_SKIP_REH_BUILD"
LOG_PATH = REPO_ROOT / "dist" / "reh-dev-build.log"


def host_target(machine: str | None = None) -> str | None:
	"""The glibc server matching this machine's CPU; None for a CPU DevHub has
	no server for."""
	machine = (machine or platform.machine()).lower()
	if machine in ("arm64", "aarch64"):
		return "linux-arm64"
	if machine in ("x86_64", "amd64", "x64"):
		return "linux-x64"
	return None


def target_problems(target: str, directory: Path, commit: str, identity: str) -> list[str]:
	"""Why `target` in `directory` is missing or stale; empty when it is current."""
	return bundle_problems(directory, commit, identity, required=(target,))


def skip_requested(env: dict[str, str] | None = None) -> bool:
	value = (env if env is not None else os.environ).get(SKIP_ENV, "")
	return value.strip().lower() not in ("", "0", "false", "no")


def say(message: str) -> None:
	print(f"[devhub] {message}", file=sys.stderr, flush=True)


def ensure(
	target: str | None,
	directory: Path = DEFAULT_OUT_DIR,
	*,
	env: dict[str, str] | None = None,
	commit: str | None = None,
	identity: str | None = None,
	docker=docker_available,
	build=None,
) -> int:
	"""Build `target` when missing or stale. Always returns 0 (never blocks)."""
	if target is None:
		say(f"no bundled remote server for CPU {platform.machine()}; skipping")
		return 0
	if skip_requested(env):
		say(f"{SKIP_ENV} is set: not building the {target} remote server")
		return 0
	problems = target_problems(
		target, directory, commit or vscode_commit(), identity or reh_identity()
	)
	if not problems:
		return 0
	command = f"scripts/build_reh.py {target}"
	say(f"the {target} remote server is missing or stale ({problems[0]})")
	if not docker():
		say(
			"Docker is not available or not running, so it cannot be built now. Remote "
			f"windows will not work until you start Docker and run: {command}"
		)
		return 0
	say(
		f"building {target} — this can take ~15 minutes the first time and after any "
		"patch or VS Code change. The app starts when it is done "
		f"(skip with {SKIP_ENV}=1). Log: {LOG_PATH}"
	)
	build = build or run_build
	if build(target) != 0:
		say(
			f"building {target} failed, continuing without it. Remote windows will not "
			f"work until it is built: {command} (log: {LOG_PATH})"
		)
	else:
		say(f"{target} remote server is ready")
	return 0


def run_build(
	targets: str | list[str], log_path: Path = LOG_PATH, extra: tuple[str, ...] = ()
) -> int:
	"""Run build_reh.py for `targets`, mirroring its output to the terminal and
	the log. Shared with scripts/ensure_reh.py (the packaging path)."""
	names = [targets] if isinstance(targets, str) else list(targets)
	log_path.parent.mkdir(parents=True, exist_ok=True)
	with log_path.open("w") as log:
		proc = subprocess.Popen(
			[sys.executable, str(Path(__file__).with_name("build_reh.py")), *names, *extra],
			stdout=subprocess.PIPE,
			stderr=subprocess.STDOUT,
			text=True,
		)
		assert proc.stdout is not None
		for line in proc.stdout:
			log.write(line)
			log.flush()
			sys.stderr.write(f"[reh] {line}")
		return proc.wait()


def main() -> int:
	try:
		return ensure(host_target())
	except Exception as error:  # the app must start regardless
		say(f"could not check the remote server ({error}); continuing")
		return 0


if __name__ == "__main__":
	sys.exit(main())
