#!/usr/bin/env python3
"""Get the remote extension hosts a local package needs and does not have.

`pnpm build` (scripts/build-app.sh -> scripts/package-nightly.py) bundles four
servers from dist/reh. For each one missing or stale there (same check as
`bundle_problems` and `dev_reh.py`), in order:

1. the local server cache, `~/.cache/devhub/reh/<identity>/` — what an
   earlier build or download left;
2. the prebuilt server the nightly published for this identity
   (scripts/reh_release.py: the `reh` release), downloaded, verified against
   its statement and put in that cache;
3. a local build with scripts/build_reh.py, in Linux containers in Docker.

Each target says which of the three it came from. A download that fails for
any reason — offline, a timeout, a 403 or 404, a checksum mismatch, a
corrupted tarball — is one line saying why, and the build goes on locally.

    scripts/ensure_reh.py [--out-dir dist/reh] [--no-download | --download-only]
    scripts/ensure_reh.py --from-release TARGET... [--out-dir dist/reh]

`--no-download` (or `DEVHUB_REH_SOURCE=build`) always builds what the cache
lacks; `--download-only` (or `DEVHUB_REH_SOURCE=download`) fails instead of
building. `DEVHUB_REH_SOURCE` is how either reaches `pnpm build`.

It does nothing in CI (`CI` is set there): the nightly downloads the servers
built by its own `reh` jobs into dist/reh, and a macOS runner must never try to
build them. A stale set there still fails in package-nightly.py's bundle check.

`--from-release TARGET...` is the one part that does run in CI: each of the
nightly's `reh` jobs asks it first, so a target whose identity the `reh`
release already has is downloaded (verified, as above) instead of rebuilt. It
never builds; it prints the targets it could not get, space-separated, on
stdout, and the job builds exactly those.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
from pathlib import Path

import reh_release
from build_reh import (
	DEFAULT_OUT_DIR,
	REPO_ROOT,
	TARGETS,
	docker_available,
	reh_cache_root,
	restore_cached_server,
	time_note,
)
from dev_reh import run_build, target_problems
from product_metadata import reh_identity, vscode_commit

LOG_PATH = REPO_ROOT / "dist" / "reh-build.log"
SOURCE_ENV = "DEVHUB_REH_SOURCE"
MODES = ("auto", "build", "download")


def in_ci(env: dict[str, str] | None = None) -> bool:
	value = (env if env is not None else os.environ).get("CI", "")
	return value.strip().lower() not in ("", "0", "false", "no")


def mode_from_env(env: dict[str, str]) -> str:
	value = env.get(SOURCE_ENV, "").strip().lower()
	return value if value in MODES else "auto"


def missing_targets(directory: Path, commit: str, identity: str) -> list[str]:
	"""The targets of the four whose server is missing or stale in `directory`."""
	return [t for t in TARGETS if target_problems(t, directory, commit, identity)]


def say(message: str) -> None:
	print(f"==> {message}", file=sys.stderr, flush=True)


def download(
	todo: list[str],
	directory: Path,
	commit: str,
	identity: str,
	cache_root: Path,
	*,
	env: dict[str, str],
	lookup=reh_release.release_assets,
	fetch=reh_release.fetch,
) -> list[str]:
	"""Fetch what the `reh` release has of `todo` into the cache and `directory`.
	Returns the targets that got one. Never raises: every failure is a line."""
	got: list[str] = []
	repo = reh_release.repo_slug(env)
	try:
		assets = lookup(repo, reh_release.github_token(env))
	except Exception as error:  # noqa: BLE001 - any failure means "build instead"
		say(f"no prebuilt servers ({error}); falling back to a local build")
		return got
	for target in todo:
		try:
			url = fetch(target, commit, identity, cache_root / identity, assets)
		except Exception as error:  # noqa: BLE001
			say(f"{target}: prebuilt not used ({error}); falling back to a local build")
			continue
		if restore_cached_server(target, commit, identity, directory, root=cache_root):
			say(f"{target}: downloaded the prebuilt server ({url})")
			got.append(target)
		else:
			say(f"{target}: the downloaded server did not verify; falling back to a local build")
	return got


def fetch_published(
	targets: list[str],
	directory: Path,
	*,
	env: dict[str, str] | None = None,
	commit: str | None = None,
	identity: str | None = None,
	cache_root: Path | None = None,
	lookup=reh_release.release_assets,
	fetch=reh_release.fetch,
) -> list[str]:
	"""Put what the `reh` release has of `targets` into `directory`, CI or not.
	Returns the targets still missing there. Never builds, never raises."""
	env = env if env is not None else dict(os.environ)
	commit = commit or vscode_commit()
	identity = identity or reh_identity()
	cache_root = cache_root or reh_cache_root()
	todo = [t for t in targets if target_problems(t, directory, commit, identity)]
	if todo:
		for target in download(todo, directory, commit, identity, cache_root, env=env, lookup=lookup, fetch=fetch):
			todo.remove(target)
	return todo


def ensure(
	directory: Path = DEFAULT_OUT_DIR,
	*,
	env: dict[str, str] | None = None,
	commit: str | None = None,
	identity: str | None = None,
	mode: str | None = None,
	cache_root: Path | None = None,
	docker=docker_available,
	build=run_build,
	lookup=reh_release.release_assets,
	fetch=reh_release.fetch,
) -> int:
	"""0 when every server is present and current afterwards, 1 otherwise."""
	env = env if env is not None else dict(os.environ)
	if in_ci(env):
		return 0
	mode = mode or mode_from_env(env)
	commit = commit or vscode_commit()
	identity = identity or reh_identity()
	cache_root = cache_root or reh_cache_root()
	todo = missing_targets(directory, commit, identity)
	if not todo:
		return 0

	for target in [t for t in todo if restore_cached_server(t, commit, identity, directory, root=cache_root)]:
		say(f"{target}: from the local cache ({cache_root / identity})")
		todo.remove(target)
	if todo and mode != "build":
		for target in download(todo, directory, commit, identity, cache_root, env=env, lookup=lookup, fetch=fetch):
			todo.remove(target)
	if not todo:
		return 0

	names = " ".join(todo)
	if mode == "download":
		print(
			f"error: no usable prebuilt remote extension host for {names} (identity {identity}), "
			f"and --download-only / {SOURCE_ENV}=download forbids building. Build them with: "
			f"scripts/build_reh.py {names}",
			file=sys.stderr,
		)
		return 1
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
		f"remote extension hosts to build locally: {names} (missing or stale in {directory}). "
		f"They are built in Linux containers in Docker; {time_note()}. "
		f"Log: {LOG_PATH}  (skip with --without-reh)"
	)
	extra = () if directory == DEFAULT_OUT_DIR else ("--out-dir", str(directory))
	if build(todo, LOG_PATH, extra) != 0:
		# Servers that did get built stay in `directory`; only the rest is retried.
		left = missing_targets(directory, commit, identity) or todo
		command = f"scripts/build_reh.py {' '.join(left)}"
		print(
			f"error: building the remote extension hosts failed (log: {LOG_PATH}). "
			f"Still missing: {' '.join(left)}. Retry with: {command}, or pass --without-reh.",
			file=sys.stderr,
		)
		return 1
	for target in todo:
		say(f"{target}: built locally")
	return 0


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
	group = parser.add_mutually_exclusive_group()
	group.add_argument("--no-download", action="store_true", help="never download; build what the cache lacks")
	group.add_argument("--download-only", action="store_true", help="fail rather than build")
	group.add_argument(
		"--from-release",
		nargs="+",
		metavar="TARGET",
		choices=TARGETS,
		help="only download these from the reh release (also under CI); print the ones still missing",
	)
	args = parser.parse_args(argv)
	if args.from_release:
		# stdout is the answer and nothing else: the workflow reads it.
		with contextlib.redirect_stdout(sys.stderr):
			missing = fetch_published(args.from_release, args.out_dir.resolve())
		print(" ".join(missing))
		return 0
	mode = "build" if args.no_download else "download" if args.download_only else None
	return ensure(args.out_dir.resolve(), mode=mode)


if __name__ == "__main__":
	sys.exit(main())
