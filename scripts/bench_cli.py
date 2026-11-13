#!/usr/bin/env python3
"""How long each `devhub` command takes, and where the time goes.

Runs each command `-n` times against the DevHub listening on
`$DEVHUB_CONTROL_SOCKET` (set `DEVHUB_MACHINE` too, to ask as a host does)
with `DEVHUB_TRACE=1`, and prints, per command, the wall time — the first
run, the median and the fastest — and the median of each stage the command
traces (`cli/trace.go`):

  start    process start to `main` (exec, the Go runtime): wall minus exit
  dial     `main` to connected: arguments, environment, the socket's connect
  app      written to answered: the app's parse, dispatch and work, and the
           transport both ways (over a host's forwarded socket, the network)
  again    a second request on the same command (`--tell`'s piped text):
           written to answered again
  print    answered to exit

    scripts/bench-cli.sh                         every command, 15 runs each
    scripts/bench-cli.sh -n 5 version board      just those
    scripts/bench-cli.sh --file ~/w/a.txt open   `devhub <file>` too
    scripts/bench-cli.sh --as dhbench ...        each run as that user (a
                                                 host's pane, on this machine)

Nothing here starts DevHub: start it, open what the commands should find,
and point the socket at it. Every run is a real request — `open` opens the
file, `stdin` a new spooled file each time — so use a throwaway profile.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# name -> (argv after `devhub`, stdin or None)
COMMANDS: dict[str, tuple[list[str], str | None]] = {
	"version": (["--version"], None),
	"help": (["--tell", "help"], None),
	"board": (["--tell", "board"], None),
	"usage": (["--tell", "usage"], None),
	"workspaces": (["--tell", "workspaces"], None),
	"json": (["--tell", "--json", "workspaces"], None),
	# The text is asked for, then sent: two requests. The agent is not there,
	# so it ends refused — after the round trip that is being timed.
	"tell-stdin": (["--tell", "agent", "send", "no-such-agent", "-"], "bench\n"),
	"stdin": (["-"], "bench\n"),
	"open": ([], None),  # the file is --file's
}

STAGES = ("start", "dial", "app", "again", "print")


def default_devhub() -> Path:
	machine = platform.machine()
	arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
	system = "darwin" if sys.platform == "darwin" else "linux"
	return REPO / "apps" / "desktop" / "out" / "cli" / f"{system}-{arch}" / "devhub"


def parse_trace(stderr: str) -> dict[str, float]:
	"""The marks of the `devhub-trace:` line, by stage, in ms since main."""
	for line in stderr.splitlines():
		if line.startswith("devhub-trace: "):
			marks = {}
			for part in line[len("devhub-trace: ") :].split():
				name, _, value = part.partition("=")
				marks[name] = float(value)
			return marks
	return {}


def stages_of(wall_ms: float, marks: dict[str, float]) -> dict[str, float]:
	"""The stages of one run, from its wall time and its trace."""
	if "exit" not in marks:
		return {}
	stages = {"start": max(0.0, wall_ms - marks["exit"])}
	if "connected" in marks:
		stages["dial"] = marks["connected"]
	if "written" in marks and "answered" in marks:
		stages["app"] = marks["answered"] - marks["written"]
	if "written#2" in marks and "answered#2" in marks:
		stages["again"] = marks["answered#2"] - marks["written#2"]
	last = max(v for k, v in marks.items() if k.startswith("answered")) if any(
		k.startswith("answered") for k in marks
	) else marks["exit"]
	stages["print"] = marks["exit"] - last
	return stages


def run_once(argv: list[str], stdin: str | None, env: dict[str, str]) -> tuple[float, int, str]:
	started = time.perf_counter()
	done = subprocess.run(
		argv,
		input=stdin,
		stdout=subprocess.DEVNULL,
		stderr=subprocess.PIPE,
		stdin=None if stdin is not None else subprocess.DEVNULL,
		env=env,
		text=True,
	)
	return (time.perf_counter() - started) * 1000, done.returncode, done.stderr


def summarise(walls: list[float], stages: list[dict[str, float]]) -> dict[str, float]:
	summary = {
		"first": walls[0],
		"median": statistics.median(walls),
		"min": min(walls),
	}
	for stage in STAGES:
		values = [run[stage] for run in stages if stage in run]
		if values:
			summary[stage] = statistics.median(values)
	return summary


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
	parser.add_argument("commands", nargs="*", help=f"some of: {', '.join(COMMANDS)}")
	parser.add_argument("-n", type=int, default=15, help="runs per command")
	parser.add_argument("--devhub", type=Path, default=default_devhub())
	parser.add_argument("--file", help="the file `open` opens")
	parser.add_argument("--as", dest="user", help="run each command as this user (runuser)")
	parser.add_argument("--label", default="", help="a name for this set of runs")
	parser.add_argument("--json", action="store_true", help="one JSON object per command")
	options = parser.parse_args()

	if "DEVHUB_CONTROL_SOCKET" not in os.environ:
		print("bench-cli: set DEVHUB_CONTROL_SOCKET to the socket of a running DevHub", file=sys.stderr)
		return 2
	names = options.commands or [n for n in COMMANDS if n != "open" or options.file]
	unknown = [n for n in names if n not in COMMANDS]
	if unknown:
		print(f"bench-cli: no command {', '.join(unknown)} (commands: {', '.join(COMMANDS)})", file=sys.stderr)
		return 2
	if "open" in names and not options.file:
		print("bench-cli: open needs --file", file=sys.stderr)
		return 2

	env = dict(os.environ, DEVHUB_TRACE="1")
	env.setdefault("DEVHUB_LAUNCH_COMMAND", '["/bin/false"]')
	prefix: list[str] = []
	if options.user:
		keep = ",".join(k for k in env if k.startswith("DEVHUB_"))
		prefix = ["runuser", "-u", options.user, f"--whitelist-environment={keep}", "--"]

	if not options.json:
		header = f"{'command':<12}{'first':>9}{'median':>9}{'min':>9}" + "".join(f"{s:>9}" for s in STAGES)
		print(f"# {options.label or 'devhub'}: ms, median of {options.n} runs per stage")
		print(header)
	for name in names:
		args, stdin = COMMANDS[name]
		if name == "open":
			args = [options.file]
		argv = prefix + [str(options.devhub), *args]
		walls, stages, codes = [], [], set()
		for _ in range(options.n):
			wall, code, stderr = run_once(argv, stdin, env)
			walls.append(wall)
			codes.add(code)
			stages.append(stages_of(wall, parse_trace(stderr)))
		summary = summarise(walls, stages)
		if options.json:
			print(json.dumps({"label": options.label, "command": name, "exit": sorted(codes), **summary}))
			continue
		cells = f"{name:<12}{summary['first']:>9.1f}{summary['median']:>9.1f}{summary['min']:>9.1f}"
		cells += "".join(f"{summary[s]:>9.1f}" if s in summary else f"{'-':>9}" for s in STAGES)
		print(cells + ("" if codes == {0} else f"   exit {sorted(codes)}"))
	return 0


if __name__ == "__main__":
	sys.exit(main())
