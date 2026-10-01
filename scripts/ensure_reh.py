#!/usr/bin/env python3
"""Build the remote extension hosts a local package needs and does not have.

`pnpm build` (scripts/build-app.sh -> scripts/package-nightly.py) bundles four
servers from dist/reh. On a developer's Mac nothing else makes them, so this
builds exactly the missing or stale ones (same check as `bundle_problems` and
`dev_reh.py`) with scripts/build_reh.py, before the long packaging steps.

It does nothing in CI (`CI` is set there): the nightly downloads the servers
built by its own `reh` jobs into dist/reh, and a macOS runner must never try to
build them. A stale set there still fails in package-nightly.py's bundle check.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from build_reh import DEFAULT_OUT_DIR, REPO_ROOT, TARGETS, docker_available
from dev_reh import run_build, target_problems
from product_metadata import reh_identity, vscode_commit

LOG_PATH = REPO_ROOT / "dist" / "reh-build.log"
MINUTES_EACH = 15


def in_ci(env: dict[str, str] | None = None) -> bool:
	value = (env if env is not None else os.environ).get("CI", "")
	return value.strip().lower() not in ("", "0", "false", "no")


def missing_targets(directory: Path, commit: str, identity: str) -> list[str]:
	"""The targets of the four whose server is missing or stale in `directory`."""
	return [t for t in TARGETS if target_problems(t, directory, commit, identity)]


def say(message: str) -> None:
	print(f"==> {message}", file=sys.stderr, flush=True)


def ensure(
	directory: Path = DEFAULT_OUT_DIR,
	*,
	env: dict[str, str] | None = None,
	commit: str | None = None,
	identity: str | None = None,
	docker=docker_available,
	build=run_build,
) -> int:
	"""0 when every server is present and current afterwards, 1 otherwise."""
	if in_ci(env):
		return 0
	todo = missing_targets(directory, commit or vscode_commit(), identity or reh_identity())
	if not todo:
		return 0
	names = " ".join(todo)
	command = f"scripts/build_reh.py {names}"
	if not docker():
		print(
			f"error: the remote extension hosts need building ({names}) and Docker is not "
			f"available or not running.\n  Start Docker and run this again, or build them "
			f"yourself: {command}\n  Or pass --without-reh for a bundle that opens no "
			"remote window.",
			file=sys.stderr,
		)
		return 1
	say(
		f"remote extension hosts to build: {names} (missing or stale in {directory}). "
		f"Docker is used; this may take ~{MINUTES_EACH} minutes each. "
		f"Log: {LOG_PATH}  (skip with --without-reh)"
	)
	extra = () if directory == DEFAULT_OUT_DIR else ("--out-dir", str(directory))
	if build(todo, LOG_PATH, extra) != 0:
		# Servers that did get built stay in `directory`; only the rest is retried.
		left = missing_targets(directory, commit or vscode_commit(), identity or reh_identity()) or todo
		command = f"scripts/build_reh.py {' '.join(left)}"
		print(
			f"error: building the remote extension hosts failed (log: {LOG_PATH}). "
			f"Still missing: {' '.join(left)}. Retry with: {command}, or pass --without-reh.",
			file=sys.stderr,
		)
		return 1
	return 0


if __name__ == "__main__":
	sys.exit(ensure())
