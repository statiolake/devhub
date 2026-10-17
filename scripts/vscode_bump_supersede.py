#!/usr/bin/env python3
"""Close the open VS Code bump pull requests a newer bump has superseded.

    scripts/vscode_bump_supersede.py <new-version>

The bump workflow opens `bump/vscode-<version>` branches and labels each pull
request `vscode-bump`. When the pull request for <new-version> is open, every
other open pull request that carries the label, comes from a `bump/vscode-`
branch of this repository and targets a LOWER version is commented on
("Superseded by #N (VS Code X)."), closed, and has its branch deleted. Anything
else, such as a person's pull request, a fork's, or an equal or newer version,
is left alone.

Needs `gh` authenticated (GH_TOKEN) and GITHUB_REPOSITORY (owner/name). Safe to
run again and when there is nothing to close; a failure on one pull request is
reported and the rest still run, then the exit status is 1.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

LABEL = "vscode-bump"
BRANCH_PREFIX = "bump/vscode-"
VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def parse_version(text: str) -> tuple[int, int, int] | None:
	m = VERSION.match(text.strip())
	return (int(m[1]), int(m[2]), int(m[3])) if m else None


def branch_version(branch: str) -> tuple[int, int, int] | None:
	if not branch.startswith(BRANCH_PREFIX):
		return None
	return parse_version(branch[len(BRANCH_PREFIX) :])


def is_bump_pr(pr: dict) -> bool:
	"""Created by the bump workflow: its label, its branch prefix, this repo."""
	labels = {label.get("name") for label in pr.get("labels", [])}
	return (
		LABEL in labels
		and not pr.get("isCrossRepository", False)
		and branch_version(pr.get("headRefName", "")) is not None
	)


def find_new_pr(prs: list[dict], new_version: str) -> dict | None:
	want = parse_version(new_version)
	if want is None:
		return None
	for pr in prs:
		if is_bump_pr(pr) and branch_version(pr["headRefName"]) == want:
			return pr
	return None


def select_superseded(prs: list[dict], new_version: str) -> list[dict]:
	"""Open bump pull requests whose version is lower than `new_version`."""
	want = parse_version(new_version)
	if want is None:
		return []
	return [
		pr
		for pr in prs
		if is_bump_pr(pr) and branch_version(pr["headRefName"]) < want  # type: ignore[operator]
	]


def gh(*args: str) -> str:
	return subprocess.run(
		["gh", *args], check=True, capture_output=True, text=True
	).stdout


def main(argv: list[str]) -> int:
	if len(argv) != 2 or parse_version(argv[1]) is None:
		print(f"usage: {argv[0]} <new-version, e.g. 1.142.0>", file=sys.stderr)
		return 2
	new_version = argv[1]
	repo = os.environ["GITHUB_REPOSITORY"]
	prs = json.loads(
		gh(
			"pr", "list", "--state", "open", "--label", LABEL, "--limit", "200",
			"--json", "number,headRefName,isCrossRepository,labels",
		)
	)
	new = find_new_pr(prs, new_version)
	if new is None:
		print(f"no open bump pull request for {new_version}; nothing to supersede")
		return 0
	failed = 0
	old = select_superseded(prs, new_version)
	if not old:
		print(f"no older bump pull requests to close (new: #{new['number']})")
	for pr in old:
		number, branch = str(pr["number"]), pr["headRefName"]
		try:
			gh(
				"pr", "close", number,
				"--comment", f"Superseded by #{new['number']} (VS Code {new_version}).",
			)
			print(f"closed #{number}")
		except subprocess.CalledProcessError as e:
			print(f"::error::could not close #{number}: {e.stderr.strip()}")
			failed += 1
			continue
		try:
			gh("api", "-X", "DELETE", f"repos/{repo}/git/refs/heads/{branch}")
			print(f"deleted branch {branch}")
		except subprocess.CalledProcessError as e:
			print(f"::error::could not delete {branch}: {e.stderr.strip()}")
			failed += 1
	return 1 if failed else 0


if __name__ == "__main__":
	sys.exit(main(sys.argv))
