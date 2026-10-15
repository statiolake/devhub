#!/usr/bin/env python3
"""The prebuilt remote extension hosts, published by the nightly as release assets.

Building the four servers is an hour or more on a Mac. The nightly builds the
same servers from the same inputs anyway, so it publishes each one it builds
and `scripts/ensure_reh.py` fetches it instead of building, when the identity
matches.

## Layout

One rolling prerelease, tag `reh` ("Remote extension hosts (prebuilt)"), with
two assets per target and identity:

    <identity>-devhub-reh-<target>.tar.gz   the tarball, as build_reh.py packs it
    <identity>-devhub-reh-<target>.json     its statement, unchanged

The identity is `reh_identity()` (scripts/product_metadata.py): the VS Code
commit, DevHub's patches, the product metadata the server carries, the build
scripts' bytes and `REH_REVISION`. A name made of it is the whole lookup, so a
reader needs no index and no tag per identity, and the release page stays one
entry. The statement is uploaded after its tarball, so a statement that is
there names a tarball that is there. Only identities the release does not have
yet are uploaded; all but the `KEEP` most recently uploaded identities are
deleted on each publish.

## Verifying a download

The statement must name the target, the commit and the identity the checkout
computes, and `devhub-reh-<target>.tar.gz` as its file; the tarball must hash
to its sha256 and be a readable tar with everything under its
`topLevelDirectory`. Only then is it put in the local server cache
(`~/.cache/devhub/reh/<identity>/`), from where build_reh.py's own
`restore_cached_server` copies it into `dist/reh` — the same check every
cached server passes.

    scripts/reh_release.py publish DIR [--keep N]   (CI: needs gh and GH_TOKEN)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

from build_reh import REPO_ROOT, TARGETS, statement_name, tarball_name

RELEASE_TAG = "reh"
RELEASE_TITLE = "Remote extension hosts (prebuilt)"
DEFAULT_REPO = "statiolake/devhub"
KEEP = 6
TIMEOUT = 30  # seconds, per connect and per read
API = "https://api.github.com"
USER_AGENT = "devhub-ensure-reh"


class FetchError(Exception):
	"""A prebuilt server that could not be used, with why."""


def asset_name(identity: str, filename: str) -> str:
	return f"{identity}-{filename}"


def repo_slug(env: dict[str, str] | None = None) -> str:
	"""`owner/repo` the releases are read from: `DEVHUB_REH_REPO`, else origin's
	GitHub remote, else DevHub's own repository."""
	env = env if env is not None else os.environ
	if env.get("DEVHUB_REH_REPO"):
		return env["DEVHUB_REH_REPO"]
	try:
		url = subprocess.run(
			["git", "-C", str(REPO_ROOT), "remote", "get-url", "origin"],
			capture_output=True, text=True, timeout=5,
		).stdout.strip()
	except (OSError, subprocess.SubprocessError):
		url = ""
	match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", url)
	return match.group(1) if match else DEFAULT_REPO


def github_token(env: dict[str, str] | None = None) -> str | None:
	"""A token for the one API call, only for the rate limit: `GITHUB_TOKEN`,
	`GH_TOKEN`, or `gh auth token`. None is fine — the repository is public."""
	env = env if env is not None else os.environ
	for name in ("GITHUB_TOKEN", "GH_TOKEN"):
		if env.get(name):
			return env[name]
	if shutil.which("gh"):
		try:
			out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=5)
			if out.returncode == 0 and out.stdout.strip():
				return out.stdout.strip()
		except (OSError, subprocess.SubprocessError):
			pass
	return None


def _open(url: str, headers: dict[str, str], opener):
	request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **headers})
	return opener(request, timeout=TIMEOUT)


def release_assets(repo: str, token: str | None, opener=urllib.request.urlopen) -> dict[str, str]:
	"""The `reh` release's assets, name -> download URL. Raises FetchError."""
	headers = {"Accept": "application/vnd.github+json"}
	if token:
		headers["Authorization"] = f"Bearer {token}"
	url = f"{API}/repos/{repo}/releases/tags/{RELEASE_TAG}"
	try:
		with _open(url, headers, opener) as response:
			release = json.loads(response.read())
	except urllib.error.HTTPError as error:
		if error.code == 404:
			raise FetchError(f"{repo} has no '{RELEASE_TAG}' release") from None
		if error.code in (403, 429):
			raise FetchError(f"GitHub refused the lookup (HTTP {error.code}, rate limit?)") from None
		raise FetchError(f"looking up the release failed: HTTP {error.code}") from None
	except (urllib.error.URLError, OSError, ValueError) as error:
		raise FetchError(f"looking up the release failed: {getattr(error, 'reason', error)}") from None
	return {
		a["name"]: a["browser_download_url"]
		for a in release.get("assets", [])
		if isinstance(a, dict) and a.get("name") and a.get("browser_download_url")
	}


def _download(url: str, destination: Path, opener) -> None:
	# The download URLs of a public repository need no token, and sending one
	# along the redirect to the storage host would only get it refused.
	try:
		with _open(url, {"Accept": "application/octet-stream"}, opener) as response, destination.open("wb") as out:
			shutil.copyfileobj(response, out, 1024 * 1024)
	except urllib.error.HTTPError as error:
		raise FetchError(f"downloading {url} failed: HTTP {error.code}") from None
	except (urllib.error.URLError, OSError) as error:
		raise FetchError(f"downloading {url} failed: {getattr(error, 'reason', error)}") from None


def _sha256(path: Path) -> str:
	digest = hashlib.sha256()
	with path.open("rb") as handle:
		while chunk := handle.read(1024 * 1024):
			digest.update(chunk)
	return digest.hexdigest()


def verify(said: dict, tarball: Path, target: str, commit: str, identity: str) -> None:
	"""Raise FetchError unless `said` and `tarball` are the server this checkout
	wants for `target`."""
	for key, want in (("target", target), ("commit", commit), ("identity", identity), ("file", tarball_name(target))):
		if said.get(key) != want:
			raise FetchError(f"its statement says {key} {said.get(key)!r}, this checkout wants {want!r}")
	if _sha256(tarball) != said.get("sha256"):
		raise FetchError("the tarball does not hash to its statement's sha256")
	top = said.get("topLevelDirectory") or ""
	try:
		with tarfile.open(tarball, "r:gz") as archive:
			for member in archive:
				if member.name.split("/", 1)[0] != top:
					raise FetchError(f"the tarball holds {member.name} outside {top}/")
	except (tarfile.TarError, OSError, EOFError) as error:
		raise FetchError(f"the tarball is not readable: {error}") from None


def fetch(
	target: str,
	commit: str,
	identity: str,
	cache_dir: Path,
	assets: dict[str, str],
	opener=urllib.request.urlopen,
) -> str:
	"""Download `target`'s prebuilt server for `identity` into `cache_dir` (the
	local server cache's directory for that identity), verified. Returns the
	tarball's URL; raises FetchError with the reason otherwise."""
	statement_url = assets.get(asset_name(identity, statement_name(target)))
	tarball_url = assets.get(asset_name(identity, tarball_name(target)))
	if not statement_url or not tarball_url:
		raise FetchError(f"no prebuilt {target} for identity {identity}")
	cache_dir.mkdir(parents=True, exist_ok=True)
	partial = cache_dir / (tarball_name(target) + ".download")
	said_partial = cache_dir / (statement_name(target) + ".download")
	try:
		_download(statement_url, said_partial, opener)
		try:
			said = json.loads(said_partial.read_text())
		except (OSError, ValueError) as error:
			raise FetchError(f"its statement is not JSON: {error}") from None
		if not isinstance(said, dict):
			raise FetchError("its statement is not a JSON object")
		_download(tarball_url, partial, opener)
		verify(said, partial, target, commit, identity)
		partial.replace(cache_dir / tarball_name(target))
		said_partial.replace(cache_dir / statement_name(target))
	finally:
		partial.unlink(missing_ok=True)
		said_partial.unlink(missing_ok=True)
	return tarball_url


# --- publishing (CI) ----------------------------------------------------------


def gh(*args: str, capture: bool = False) -> str:
	result = subprocess.run(["gh", *args], check=True, text=True, capture_output=capture)
	return result.stdout if capture else ""


def to_upload(directory: Path, existing: set[str]) -> list[tuple[Path, str]]:
	"""(file, asset name) for each server in `directory` the release lacks —
	tarballs first, then statements, so a published statement always has its
	tarball beside it."""
	tarballs, statements = [], []
	for target in TARGETS:
		path = directory / statement_name(target)
		if not path.is_file():
			continue
		said = json.loads(path.read_text())
		identity = said["identity"]
		said_name = asset_name(identity, statement_name(target))
		if said_name in existing:
			continue
		tarballs.append((directory / tarball_name(target), asset_name(identity, tarball_name(target))))
		statements.append((path, said_name))
	return tarballs + statements


def to_prune(assets: list[dict], keep: int, current: set[str]) -> list[str]:
	"""Asset names of all but the `keep` most recently uploaded identities (and
	never those in `current`)."""
	newest: dict[str, str] = {}
	for asset in assets:
		identity = asset["name"].split("-", 1)[0]
		newest[identity] = max(newest.get(identity, ""), asset.get("createdAt", ""))
	ranked = sorted(newest, key=lambda i: newest[i], reverse=True)
	kept = set(ranked[:max(keep, 0)]) | current
	return [a["name"] for a in assets if a["name"].split("-", 1)[0] not in kept]


def publish(directory: Path, keep: int = KEEP) -> int:
	if subprocess.run(["gh", "release", "view", RELEASE_TAG], capture_output=True).returncode != 0:
		gh(
			"release", "create", RELEASE_TAG, "--prerelease", "--title", RELEASE_TITLE, "--notes",
			"The remote extension hosts the nightly builds, by identity "
			"(`<identity>-devhub-reh-<target>.tar.gz` and its `.json` statement). "
			"`scripts/ensure_reh.py` downloads the ones a checkout needs instead of "
			"building them; see docs/remote-ssh.md. Old identities are pruned.",
		)
	assets = json.loads(gh("release", "view", RELEASE_TAG, "--json", "assets", capture=True))["assets"]
	existing = {a["name"] for a in assets}
	uploads = to_upload(directory, existing)
	current = {json.loads(p.read_text())["identity"] for p in directory.glob("devhub-reh-*.json")}
	if not uploads:
		print(f"the '{RELEASE_TAG}' release already has these servers ({', '.join(sorted(current))})")
	with_names = directory / ".release-upload"
	shutil.rmtree(with_names, ignore_errors=True)
	with_names.mkdir()
	for source, name in uploads:
		shutil.copyfile(source, with_names / name)
		# One at a time, in order: the statement must not precede its tarball.
		gh("release", "upload", RELEASE_TAG, str(with_names / name))
		print(f"uploaded {name}")
	shutil.rmtree(with_names, ignore_errors=True)
	assets = json.loads(gh("release", "view", RELEASE_TAG, "--json", "assets", capture=True))["assets"]
	for name in to_prune(assets, keep, current):
		gh("release", "delete-asset", RELEASE_TAG, name, "--yes")
		print(f"pruned {name}")
	return 0


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	sub = parser.add_subparsers(dest="command", required=True)
	p = sub.add_parser("publish", help="upload the servers in DIR the release lacks, prune old identities")
	p.add_argument("directory", type=Path)
	p.add_argument("--keep", type=int, default=KEEP)
	args = parser.parse_args()
	return publish(args.directory, args.keep)


if __name__ == "__main__":
	sys.exit(main())
