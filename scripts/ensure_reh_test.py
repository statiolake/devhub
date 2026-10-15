#!/usr/bin/env python3
"""The packaging path takes each missing server from the local cache, else the
nightly's prebuilt one, else builds it — and a download that fails for any
reason is a fallback to the build, never a failed build."""

from __future__ import annotations

import functools
import hashlib
import io
import json
import socket
import tarfile
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import ensure_reh
import reh_release
from build_reh import statement_name, tarball_name, top_level_dir

COMMIT = "c" * 40
IDENTITY = "0123456789ab"
REPO = "owner/devhub"
API_URL = f"{reh_release.API}/repos/{REPO}/releases/tags/{reh_release.RELEASE_TAG}"


def make_tarball(target: str, extra: str | None = None) -> bytes:
	buffer = io.BytesIO()
	with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
		for name in [f"{top_level_dir(target)}/bin/server", *([extra] if extra else [])]:
			data = b"#!/bin/sh\n"
			info = tarfile.TarInfo(name)
			info.size = len(data)
			archive.addfile(info, io.BytesIO(data))
	return buffer.getvalue()


def make_statement(target: str, tarball: bytes, **overrides) -> bytes:
	said = {
		"target": target,
		"commit": COMMIT,
		"identity": IDENTITY,
		"file": tarball_name(target),
		"sha256": hashlib.sha256(tarball).hexdigest(),
		"topLevelDirectory": top_level_dir(target),
	}
	said.update(overrides)
	return json.dumps(said).encode()


class Response(io.BytesIO):
	def __enter__(self):
		return self

	def __exit__(self, *exc):
		self.close()


class FakeGitHub:
	"""A fake `urlopen`: the release API and its download URLs, from a dict of
	asset name -> bytes; or an exception for every request."""

	def __init__(self, assets: dict[str, bytes] | None = None, error: Exception | None = None, api_status: int = 200):
		self.assets = assets or {}
		self.error = error
		self.api_status = api_status
		self.requests: list[tuple[str, dict]] = []

	def url(self, name: str) -> str:
		return f"https://github.com/{REPO}/releases/download/reh/{name}"

	def __call__(self, request, timeout=None):
		self.requests.append((request.full_url, dict(request.header_items())))
		assert timeout, "every request needs a timeout"
		if self.error is not None:
			raise self.error
		if request.full_url == API_URL:
			if self.api_status != 200:
				raise urllib.error.HTTPError(request.full_url, self.api_status, "no", {}, None)
			body = {"assets": [{"name": n, "browser_download_url": self.url(n)} for n in self.assets]}
			return Response(json.dumps(body).encode())
		for name, data in self.assets.items():
			if request.full_url == self.url(name):
				return Response(data)
		raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)


def published(*targets: str, tamper: dict[str, dict] | None = None, corrupt: tuple[str, ...] = ()) -> dict[str, bytes]:
	assets = {}
	for target in targets:
		tarball = make_tarball(target)
		said = make_statement(target, tarball, **(tamper or {}).get(target, {}))
		if target in corrupt:
			tarball = tarball[: len(tarball) // 2]
		assets[reh_release.asset_name(IDENTITY, tarball_name(target))] = tarball
		assets[reh_release.asset_name(IDENTITY, statement_name(target))] = said
	return assets


class InCiTest(unittest.TestCase):
	def test_values(self):
		self.assertTrue(ensure_reh.in_ci({"CI": "true"}))
		self.assertFalse(ensure_reh.in_ci({"CI": ""}))
		self.assertFalse(ensure_reh.in_ci({"CI": "0"}))
		self.assertFalse(ensure_reh.in_ci({}))


class Fixture(unittest.TestCase):
	def setUp(self):
		self.tmp = Path(tempfile.mkdtemp())
		self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
		self.out = self.tmp / "out"
		self.cache = self.tmp / "cache"
		self.out.mkdir()

	def problems(self, target, directory, commit, identity):
		"""The real check, on the files the test put in `out`."""
		path = directory / statement_name(target)
		if not path.is_file():
			return ["no"]
		said = json.loads(path.read_text())
		return [] if said.get("identity") == identity and (directory / said["file"]).is_file() else ["stale"]

	def run_ensure(self, github=None, *, mode=None, docker=True, build_rc=0, env=None, build=None):
		github = github if github is not None else FakeGitHub(error=urllib.error.URLError("offline"))
		built = []

		def default_build(targets, log, extra):
			built.append(list(targets))
			return build_rc

		err, out = io.StringIO(), io.StringIO()
		with mock.patch.object(ensure_reh, "target_problems", self.problems), \
				mock.patch.object(reh_release, "repo_slug", lambda env=None: REPO), \
				mock.patch.object(reh_release, "github_token", lambda env=None: (env or {}).get("GITHUB_TOKEN")), \
				redirect_stderr(err), redirect_stdout(out):
			rc = ensure_reh.ensure(
				self.out,
				env=env if env is not None else {},
				commit=COMMIT,
				identity=IDENTITY,
				mode=mode,
				cache_root=self.cache,
				docker=lambda: docker,
				build=build or default_build,
				lookup=functools.partial(reh_release.release_assets, opener=github),
				fetch=functools.partial(reh_release.fetch, opener=github),
			)
		return rc, built, err.getvalue()


class BuildFallbackTest(Fixture):
	"""What was there before downloads: building only what is missing."""

	def test_builds_all_when_nothing_is_published(self):
		rc, built, err = self.run_ensure()
		self.assertEqual(rc, 0)
		self.assertEqual(built, [list(ensure_reh.TARGETS)])
		self.assertIn("Linux containers", err)
		self.assertIn("first build", err)

	def test_failed_build_retry_lists_only_what_is_still_missing(self):
		def build(targets, log, extra):
			# alpine-x64 got built before the rest failed
			for t in ("linux-x64", "linux-arm64", "alpine-x64"):
				(self.out / tarball_name(t)).write_bytes(b"x")
				(self.out / statement_name(t)).write_text(json.dumps({"identity": IDENTITY, "file": tarball_name(t)}))
			return 1

		rc, _, err = self.run_ensure(build=build)
		self.assertEqual(rc, 1)
		self.assertIn("Retry with: scripts/build_reh.py alpine-arm64,", err)
		self.assertNotIn("alpine-x64", err.split("Still missing")[1])

	def test_nothing_missing_no_docker_and_no_network(self):
		for t in ensure_reh.TARGETS:
			(self.out / tarball_name(t)).write_bytes(b"x")
			(self.out / statement_name(t)).write_text(json.dumps({"identity": IDENTITY, "file": tarball_name(t)}))
		github = FakeGitHub()
		rc, built, _ = self.run_ensure(github, docker=False)
		self.assertEqual((rc, built, github.requests), (0, [], []))

	def test_ci_never_builds_or_downloads(self):
		github = FakeGitHub(published(*ensure_reh.TARGETS))
		rc, built, _ = self.run_ensure(github, env={"CI": "true"})
		self.assertEqual((rc, built, github.requests), (0, [], []))

	def test_no_docker_names_targets_and_escape(self):
		rc, built, err = self.run_ensure(docker=False)
		self.assertEqual((rc, built), (1, []))
		self.assertIn("scripts/build_reh.py linux-x64", err)
		self.assertIn("--without-reh", err)

	def test_build_failure(self):
		rc, _, err = self.run_ensure(build_rc=2)
		self.assertEqual(rc, 1)
		self.assertIn("--without-reh", err)


class DownloadTest(Fixture):
	def test_downloads_published_servers_and_builds_nothing(self):
		github = FakeGitHub(published(*ensure_reh.TARGETS))
		rc, built, err = self.run_ensure(github, docker=False)
		self.assertEqual((rc, built), (0, []))
		for t in ensure_reh.TARGETS:
			self.assertIn(f"{t}: downloaded the prebuilt server", err)
			self.assertTrue((self.out / tarball_name(t)).is_file())
			self.assertTrue((self.cache / IDENTITY / tarball_name(t)).is_file())
		self.assertEqual(list((self.cache / IDENTITY).glob("*.download")), [])

	def test_second_run_uses_the_local_cache_without_network(self):
		self.run_ensure(FakeGitHub(published(*ensure_reh.TARGETS)))
		for p in self.out.iterdir():
			p.unlink()
		github = FakeGitHub(error=AssertionError("no network expected"))
		rc, built, err = self.run_ensure(github, docker=False)
		self.assertEqual((rc, built, github.requests), (0, [], []))
		self.assertIn("linux-x64: from the local cache", err)

	def test_downloads_what_is_published_and_builds_the_rest(self):
		github = FakeGitHub(published("linux-x64", "alpine-x64"))
		rc, built, err = self.run_ensure(github)
		self.assertEqual(rc, 0)
		self.assertEqual(built, [["linux-arm64", "alpine-arm64"]])
		self.assertIn("linux-arm64: prebuilt not used (no prebuilt linux-arm64 for identity", err)
		self.assertIn("linux-arm64: built locally", err)

	def test_token_is_sent_to_the_api_only(self):
		github = FakeGitHub(published(*ensure_reh.TARGETS))
		self.run_ensure(github, env={"GITHUB_TOKEN": "secret"})
		for url, headers in github.requests:
			if url == API_URL:
				self.assertEqual(headers.get("Authorization"), "Bearer secret")
			else:
				self.assertNotIn("Authorization", headers)

	def test_unauthenticated_without_a_token(self):
		github = FakeGitHub(published(*ensure_reh.TARGETS))
		self.run_ensure(github)
		self.assertNotIn("Authorization", github.requests[0][1])

	def test_no_download_builds_without_asking(self):
		github = FakeGitHub(published(*ensure_reh.TARGETS))
		rc, built, err = self.run_ensure(github, mode="build")
		self.assertEqual((rc, built, github.requests), (0, [list(ensure_reh.TARGETS)], []))

	def test_mode_from_environment(self):
		self.assertEqual(ensure_reh.mode_from_env({"DEVHUB_REH_SOURCE": "build"}), "build")
		self.assertEqual(ensure_reh.mode_from_env({"DEVHUB_REH_SOURCE": "download"}), "download")
		self.assertEqual(ensure_reh.mode_from_env({}), "auto")
		github = FakeGitHub(published(*ensure_reh.TARGETS))
		_, built, _ = self.run_ensure(github, env={"DEVHUB_REH_SOURCE": "build"})
		self.assertEqual(built, [list(ensure_reh.TARGETS)])

	def test_download_only_fails_instead_of_building(self):
		github = FakeGitHub(published("linux-x64"))
		rc, built, err = self.run_ensure(github, mode="download")
		self.assertEqual((rc, built), (1, []))
		self.assertIn("--download-only", err)
		self.assertIn("linux-arm64 alpine-x64 alpine-arm64", err)

	def test_download_only_succeeds_when_all_are_published(self):
		rc, built, _ = self.run_ensure(FakeGitHub(published(*ensure_reh.TARGETS)), mode="download", docker=False)
		self.assertEqual((rc, built), (0, []))

	def test_cli_flags(self):
		with mock.patch.object(ensure_reh, "ensure", return_value=0) as ensure:
			ensure_reh.main(["--no-download"])
			self.assertEqual(ensure.call_args.kwargs["mode"], "build")
			ensure_reh.main(["--download-only"])
			self.assertEqual(ensure.call_args.kwargs["mode"], "download")
			ensure_reh.main([])
			self.assertIsNone(ensure.call_args.kwargs["mode"])
		with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
			ensure_reh.main(["--no-download", "--download-only"])


class FallbackTest(Fixture):
	"""Any failure on the download path is one line, then the local build."""

	def assert_falls_back(self, github, reason):
		rc, built, err = self.run_ensure(github)
		self.assertEqual(rc, 0)
		self.assertEqual(built, [list(ensure_reh.TARGETS)], err)
		self.assertIn("falling back to a local build", err)
		self.assertIn(reason, err)
		for t in ensure_reh.TARGETS:
			self.assertFalse((self.cache / IDENTITY / tarball_name(t)).exists())
		return err

	def test_offline(self):
		self.assert_falls_back(FakeGitHub(error=urllib.error.URLError("Name or service not known")), "Name or service not known")

	def test_timeout(self):
		self.assert_falls_back(FakeGitHub(error=socket.timeout("timed out")), "timed out")

	def test_rate_limited(self):
		self.assert_falls_back(FakeGitHub(api_status=403), "HTTP 403")

	def test_no_release(self):
		self.assert_falls_back(FakeGitHub(api_status=404), "no 'reh' release")

	def test_checksum_mismatch(self):
		tamper = {t: {"sha256": "0" * 64} for t in ensure_reh.TARGETS}
		self.assert_falls_back(FakeGitHub(published(*ensure_reh.TARGETS, tamper=tamper)), "does not hash")

	def test_corrupted_tarball(self):
		# The statement hashes the truncated bytes, so only reading it can tell.
		assets = {}
		for t in ensure_reh.TARGETS:
			bad = make_tarball(t)[:40]
			assets[reh_release.asset_name(IDENTITY, tarball_name(t))] = bad
			assets[reh_release.asset_name(IDENTITY, statement_name(t))] = make_statement(t, bad)
		self.assert_falls_back(FakeGitHub(assets), "not readable")

	def test_truncated_download(self):
		self.assert_falls_back(FakeGitHub(published(*ensure_reh.TARGETS, corrupt=ensure_reh.TARGETS)), "does not hash")

	def test_statement_for_another_identity(self):
		tamper = {t: {"identity": "ffffffffffff"} for t in ensure_reh.TARGETS}
		self.assert_falls_back(FakeGitHub(published(*ensure_reh.TARGETS, tamper=tamper)), "identity")

	def test_statement_for_another_commit(self):
		tamper = {t: {"commit": "d" * 40} for t in ensure_reh.TARGETS}
		self.assert_falls_back(FakeGitHub(published(*ensure_reh.TARGETS, tamper=tamper)), "commit")

	def test_statement_not_json(self):
		assets = published(*ensure_reh.TARGETS)
		for t in ensure_reh.TARGETS:
			assets[reh_release.asset_name(IDENTITY, statement_name(t))] = b"<html>"
		self.assert_falls_back(FakeGitHub(assets), "not JSON")

	def test_tarball_with_files_outside_its_directory(self):
		assets = {}
		for t in ensure_reh.TARGETS:
			tarball = make_tarball(t, extra="elsewhere/evil")
			assets[reh_release.asset_name(IDENTITY, tarball_name(t))] = tarball
			assets[reh_release.asset_name(IDENTITY, statement_name(t))] = make_statement(t, tarball)
		self.assert_falls_back(FakeGitHub(assets), "outside")

	def test_unexpected_exception(self):
		self.assert_falls_back(FakeGitHub(error=RuntimeError("surprise")), "surprise")


class ReleaseLayoutTest(unittest.TestCase):
	def test_asset_names(self):
		self.assertEqual(reh_release.asset_name(IDENTITY, "devhub-reh-linux-x64.tar.gz"), f"{IDENTITY}-devhub-reh-linux-x64.tar.gz")

	def test_repo_slug(self):
		self.assertEqual(reh_release.repo_slug({"DEVHUB_REH_REPO": "a/b"}), "a/b")

	def test_upload_only_what_is_missing_tarballs_first(self):
		with tempfile.TemporaryDirectory() as d:
			d = Path(d)
			for t in ("linux-x64", "alpine-x64"):
				tarball = make_tarball(t)
				(d / tarball_name(t)).write_bytes(tarball)
				(d / statement_name(t)).write_bytes(make_statement(t, tarball))
			existing = {reh_release.asset_name(IDENTITY, statement_name("linux-x64"))}
			names = [name for _, name in reh_release.to_upload(d, existing)]
		self.assertEqual(names, [f"{IDENTITY}-devhub-reh-alpine-x64.tar.gz", f"{IDENTITY}-devhub-reh-alpine-x64.json"])

	def test_prune_keeps_the_newest_identities_and_the_current_one(self):
		assets = [
			{"name": f"{i}-devhub-reh-linux-x64.tar.gz", "createdAt": f"2026-01-0{n}T00:00:00Z"}
			for n, i in enumerate(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"], start=1)
		]
		self.assertEqual(
			reh_release.to_prune(assets, 2, {"aaaaaaaaaaaa"}),
			["bbbbbbbbbbbb-devhub-reh-linux-x64.tar.gz"],
		)


if __name__ == "__main__":
	unittest.main()
