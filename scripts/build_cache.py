#!/usr/bin/env python3
"""How package-nightly.py zips the app: the one packaging step worth tuning.

Kept apart so tests can pin it without a Mac.
"""

from __future__ import annotations

from pathlib import Path


def zip_command(app: Path, archive: Path, level: str) -> tuple[list[str], Path]:
	"""(argv, cwd) for zipping an .app. Level 'ditto' keeps ditto's own default.

	Info-ZIP `zip -y` stores symlinks as symlinks and keeps Unix modes, which is
	what an .app's frameworks need; Finder, `ditto -x -k` and `unzip` read it.
	Level 0..9 is the deflate level (0 stores); 1 is ~2.5x faster than the
	default for ~10% more bytes.
	"""
	if level == "ditto":
		return ["ditto", "-c", "-k", "--keepParent", str(app), str(archive)], app.parent
	if level not in {str(i) for i in range(10)}:
		raise ValueError(f"zip level must be 0-9 or 'ditto', not {level!r}")
	return ["zip", "-r", "-y", "-q", f"-{level}", str(archive), app.name], app.parent
