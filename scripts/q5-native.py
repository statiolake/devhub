#!/usr/bin/env python3
"""Run the real-process portion of the DevHub Q5.2 acceptance protocol.

The driver is deliberately conservative.  It discovers the built DevHub
binary and the pinned OpenVSCode executable, checks whether this process has a
WindowServer/Accessibility session, and writes a bounded redacted report.  If
those prerequisites are available, ``--execute`` launches the real DevHub
binary once for setup and ten measured cold-shell attempts.  The app emits
the readiness marker from the Rust diagnostics seam after the App Shell has
committed its ready DOM.  Missing markers never become timing samples.

The remaining interactive scenarios require user input in the real WebViews;
the report records them as blocked/manual rather than substituting unit or
process timings.  ``--execute`` also runs the real Herdr and tmux provider
checks, preserving their exit status without retaining their output.
"""

from __future__ import annotations

import argparse
import datetime as datetime_module
import json
import math
import os
import platform
import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
GATE = "Q5.2"
SETUP_RUNS = 1
MEASURED_RUNS = 10
ATTEMPT_TIMEOUT_SECONDS = 8.0
OPENVSCODE_COMMIT = "4ffe2270acdf711bbefecc3e8c79f4b3631640e5"
OPENVSCODE_VERSION = "1.109.5"
ROOT = Path(__file__).resolve().parents[1]

TIMING_IDS = (
    "process_cold_shell",
    "scratch_interactive",
    "workspace_picker_first_result",
    "mounted_activity_switch",
    "cold_openvscode_interactive",
    "warm_workbench_reconstruction",
)

FORBIDDEN_KEYS = {
    "hostname",
    "host_name",
    "home",
    "serial",
    "uuid",
    "machine_id",
    "machineid",
    "username",
    "user_name",
    "login",
    "path",
    "cwd",
}


class NativeReportError(ValueError):
    """Raised when the native report violates its redaction contract."""


def nearest_rank_p95(samples: Sequence[float]) -> float:
    if not samples:
        raise NativeReportError("p95 requires samples")
    ordered = sorted(float(sample) for sample in samples)
    rank = max(1, math.ceil(0.95 * len(ordered)))
    return ordered[rank - 1]


def _version(command: Sequence[str]) -> str:
    if shutil.which(command[0]) is None:
        return "unavailable"
    try:
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return "unavailable"
    if result.returncode != 0:
        return "unavailable"
    line = (result.stdout or "").strip().splitlines()
    return " ".join(line[0].split())[:160] if line else "unavailable"


def _command_status(command: Sequence[str], timeout: float = 120.0) -> dict[str, Any]:
    """Run a real provider check while retaining only bounded safe facts."""

    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "status": "fail",
            "exit_code": None,
            "timed_out": True,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        }
    except OSError:
        return {
            "status": "unavailable",
            "exit_code": None,
            "timed_out": False,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        }
    return {
        "status": "pass" if result.returncode == 0 else "fail",
        "exit_code": int(result.returncode),
        "timed_out": False,
        "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
    }


def _regular_executable(value: Path) -> bool:
    try:
        info = value.lstat()
    except OSError:
        return False
    return (
        stat.S_ISREG(info.st_mode)
        and not stat.S_ISLNK(info.st_mode)
        and bool(info.st_mode & 0o111)
    )


def _product_matches(executable: Path) -> bool:
    root = executable.parent.parent
    try:
        product = json.loads((root / "product.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        product.get("commit") == OPENVSCODE_COMMIT
        and product.get("version") == OPENVSCODE_VERSION
        and (root / "node").is_file()
        and (root / "out" / "server-main.js").is_file()
    )


def _openvscode_candidates() -> list[tuple[str, Path]]:
    candidates: list[tuple[str, Path]] = []
    override = os.environ.get("DEVHUB_OPENVSCODE_EXECUTABLE")
    if override:
        candidates.append(("environment_override", Path(override)))
    relative = (
        ROOT / "openvscode-server" / "bin" / "openvscode-server",
        ROOT / "openvscode" / "vscode-reh-web-darwin-arm64" / "bin" / "openvscode-server",
        ROOT / "vscode-reh-web-darwin-arm64" / "bin" / "openvscode-server",
        ROOT / "target" / "debug" / "resources" / "openvscode-server" / "bin" / "openvscode-server",
        ROOT / "target" / "debug" / "resources" / "openvscode" / "vscode-reh-web-darwin-arm64" / "bin" / "openvscode-server",
    )
    candidates.extend(("workspace_or_build", path) for path in relative)
    # These are deterministic product resource locations.  They are used only
    # for discovery and are never included in the report.
    user_root = Path.home()
    candidates.extend(
        (
            "user_application_support",
            user_root / "Library" / "Application Support" / product / "openvscode-server" / "bin" / "openvscode-server",
        )
        for product in ("DevHub", "io.github.statiolake.devhub")
    )
    return candidates


def discover_openvscode() -> tuple[dict[str, Any], Path | None]:
    seen: set[str] = set()
    for source, candidate in _openvscode_candidates():
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if _regular_executable(candidate) and _product_matches(candidate):
            return (
                {
                    "status": "available",
                    "source": source,
                    "pinned_identity": "verified",
                },
                candidate,
            )
    return (
        {
            "status": "missing",
            "source": "not_found",
            "pinned_identity": "not_verified",
        },
        None,
    )


def _gui_probe() -> dict[str, Any]:
    window_server = False
    if platform.system() == "Darwin":
        window_server = (
            subprocess.run(
                ["/usr/bin/pgrep", "-qx", "WindowServer"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            ).returncode
            == 0
        )
    accessibility = "unavailable"
    if shutil.which("osascript"):
        try:
            result = subprocess.run(
                ["osascript", "-e", 'tell application "System Events" to return 1'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=5,
            )
            accessibility = "available" if result.returncode == 0 else "denied_or_absent"
        except (OSError, subprocess.SubprocessError):
            accessibility = "unavailable"
    return {
        "window_server": "available" if window_server else "unavailable",
        "accessibility": accessibility,
        "interactive_session": window_server and accessibility == "available",
    }


def probe_host() -> tuple[dict[str, Any], Path | None]:
    openvscode, executable = discover_openvscode()
    binary = ROOT / "target" / "debug" / "devhub-app"
    gui = _gui_probe()
    host = {
        "platform": {
            "os": platform.system() or "unknown",
            "os_release": platform.release() or "unknown",
            "architecture": platform.machine() or "unknown",
        },
        "toolchain": {
            "python": _version(("python3", "--version")),
            "node": _version(("node", "--version")),
            "pnpm": _version(("pnpm", "--version")),
            "rustc": _version(("rustc", "--version")),
            "cargo": _version(("cargo", "--version")),
            "tmux": _version(("tmux", "-V")),
            "herdr": _version(("herdr", "--version")),
        },
        "artifacts": {
            "devhub_debug_binary": "available" if _regular_executable(binary) else "missing",
            "openvscode": openvscode,
        },
        "gui": gui,
        "reference_context": "not_proven",
        "machine_identifiers": "omitted",
        "ambient_paths": "omitted",
    }
    return host, executable


def _marker_seen(log_file: Path, marker: str, offset: int) -> tuple[bool, int]:
    try:
        with log_file.open(encoding="utf-8") as stream:
            stream.seek(offset)
            data = stream.read(64 * 1024)
            new_offset = stream.tell()
    except OSError:
        return False, offset
    for line in data.splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("event") == "performance" and record.get("marker") == marker:
            return True, new_offset
    return False, new_offset


def _launch_shell_attempt(executable: Path, openvscode: Path | None) -> dict[str, Any]:
    """Launch DevHub and wait for the AppShell marker, retaining no output."""

    with tempfile.TemporaryDirectory(prefix="devhub-q52-") as temp_home:
        env = os.environ.copy()
        env["HOME"] = temp_home
        env["DEVHUB_Q5_PERFORMANCE"] = "1"
        if openvscode is not None:
            env["DEVHUB_OPENVSCODE_EXECUTABLE"] = str(openvscode)
        log_file = Path(temp_home) / "Library" / "Logs" / "DevHub" / "devhub.jsonl"
        started = time.monotonic()
        try:
            process = subprocess.Popen(
                [str(executable)],
                cwd=ROOT,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            return {
                "status": "unavailable",
                "elapsed_ms": None,
                "marker": "app_shell_interactive",
            }
        offset = 0
        marker_found = False
        deadline = started + ATTEMPT_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            marker_found, offset = _marker_seen(log_file, "app_shell_interactive", offset)
            if marker_found:
                break
            if process.poll() is not None:
                break
            time.sleep(0.05)
        elapsed = round((time.monotonic() - started) * 1000, 3) if marker_found else None
        status = "pass" if marker_found else "blocked"
        if not marker_found and process.poll() is not None:
            reason = "app_exit_before_marker"
        elif not marker_found:
            reason = "marker_timeout"
        else:
            reason = "marker_observed"
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        return {
            "status": status,
            "elapsed_ms": elapsed,
            "marker": "app_shell_interactive",
            "reason": reason,
        }


def _timing_entry(reason: str, attempts: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    if attempts is None:
        attempts = [
            {"role": "setup", "status": "not_executed", "reason": reason},
            *[
                {
                    "role": "measured",
                    "run": index + 1,
                    "status": "not_executed",
                    "reason": reason,
                }
                for index in range(MEASURED_RUNS)
            ],
        ]
    return {
        "status": "blocked",
        "setup_runs": SETUP_RUNS,
        "measured_runs": MEASURED_RUNS,
        "samples_ms": [],
        "p95_ms": None,
        "reason": reason,
        "attempts": attempts,
    }


def _matrix_entry(identifier: str, requirement: str, reason: str) -> dict[str, Any]:
    return {
        "id": identifier,
        "status": "blocked",
        "requirement": requirement,
        "reason": reason,
    }


def execute(host: Mapping[str, Any], openvscode: Path | None, *, run_providers: bool) -> dict[str, Any]:
    artifacts = host["artifacts"]
    gui = host["gui"]
    binary_available = artifacts["devhub_debug_binary"] == "available"
    gui_available = bool(gui["interactive_session"])
    bundle_available = artifacts["openvscode"]["status"] == "available"
    blockers: list[str] = []
    if not binary_available:
        blockers.append("devhub_debug_binary_missing")
    if not bundle_available:
        blockers.append("pinned_openvscode_bundle_missing")
    if not gui_available:
        blockers.append("native_gui_session_unavailable")
    blockers.append("reference_context_not_proven")

    shell_attempts: list[dict[str, Any]] = []
    # The Shell is a distinct native surface.  Exercise it whenever the real
    # app and GUI session exist, even if the managed editor bundle is missing;
    # the resulting marker timeout is useful blocker evidence and is never
    # promoted to an editor or reference-context timing claim.
    if binary_available and gui_available:
        binary = ROOT / "target" / "debug" / "devhub-app"
        shell_attempts.append({"role": "setup", **_launch_shell_attempt(binary, openvscode)})
        for index in range(MEASURED_RUNS):
            shell_attempts.append(
                {"role": "measured", "run": index + 1, **_launch_shell_attempt(binary, openvscode)}
            )
    else:
        shell_attempts = [
            {"role": "setup", "status": "skipped", "reason": ";".join(blockers)},
            *[
                {
                    "role": "measured",
                    "run": index + 1,
                    "status": "skipped",
                    "reason": ";".join(blockers),
                }
                for index in range(MEASURED_RUNS)
            ],
        ]

    timing_runs = {
        timing_id: _timing_entry(
            "Native marker-driven run is unavailable; no synthetic timing is recorded."
            if timing_id != "process_cold_shell"
            else "AppShell marker run is blocked by the host prerequisites.",
            shell_attempts if timing_id == "process_cold_shell" else [],
        )
        for timing_id in TIMING_IDS
    }
    shell_samples = [
        attempt["elapsed_ms"]
        for attempt in shell_attempts
        if attempt.get("role") == "measured"
        and attempt.get("status") == "pass"
        and isinstance(attempt.get("elapsed_ms"), (int, float))
    ]
    if len(shell_samples) == MEASURED_RUNS:
        timing_runs["process_cold_shell"].update(
            {
                "status": "measured",
                "samples_ms": shell_samples,
                "p95_ms": nearest_rank_p95(shell_samples),
                "reason": "Real DevHub launches; AppShell DOM marker observed after one setup run.",
            }
        )
    elif any(attempt.get("reason") == "marker_timeout" for attempt in shell_attempts):
        timing_runs["process_cold_shell"]["reason"] = (
            "Real DevHub was launched for one setup and ten measured attempts, but the "
            "Rust-owned App Shell marker was not observed before timeout; the missing "
            "pinned OpenVSCode bundle prevents a usable interactive surface."
        )

    provider_checks: dict[str, Any] = {}
    if run_providers:
        provider_checks["herdr_real_runtime"] = {
            "command": "scripts/check-agent-runtime-real.sh",
            **_command_status(("scripts/check-agent-runtime-real.sh",), timeout=180),
        }
        provider_checks["tmux_transition_matrix"] = {
            "command": "cargo test real tmux transition",
            **_command_status(
                (
                    "cargo",
                    "test",
                    "--offline",
                    "--locked",
                    "-p",
                    "devhub-app",
                    "--lib",
                    "terminal::tests::real_transition_sockets_cover_conflicts_unknown_preservation_and_dynamic_rebind",
                    "--",
                    "--exact",
                ),
                timeout=180,
            ),
        }
        provider_checks["tmux_pty_continuity"] = {
            "command": "cargo test real tmux pty roundtrip",
            **_command_status(
                (
                    "cargo",
                    "test",
                    "--offline",
                    "--locked",
                    "-p",
                    "devhub-app",
                    "--lib",
                    "terminal::tests::real_tmux_pty_roundtrip_resize_detach_and_replacement_preserve_session",
                    "--",
                    "--exact",
                ),
                timeout=180,
            ),
        }
        provider_checks["lifecycle_gate"] = {
            "command": "cargo test integration lifecycle gate",
            **_command_status(
                (
                    "cargo",
                    "test",
                    "--offline",
                    "--locked",
                    "-p",
                    "devhub-app",
                    "--lib",
                    "integration::lifecycle::tests",
                    "--",
                    "--nocapture",
                ),
                timeout=180,
            ),
        }
        provider_checks["scale_identity_reconciliation"] = {
            "command": "cargo test eight workspaces sixteen agents identity",
            **_command_status(
                (
                    "cargo",
                    "test",
                    "--offline",
                    "--locked",
                    "-p",
                    "devhub-app",
                    "--lib",
                    "tests::lifecycle_rehydrates_eight_workspaces_and_sixteen_agents_without_duplicates",
                    "--",
                    "--exact",
                ),
                timeout=180,
            ),
        }

    native_reason = "GUI, pinned bundle, and reference context are required for this native matrix."
    scale = [
        _matrix_entry(
            "scale-eight-workspaces-sixteen-agents-nine-editors",
            "8 Workspaces; 16 live Agents across >=4 Workspaces; 9 Editor WebViews",
            native_reason,
        ),
        _matrix_entry(
            "hidden-editor-continuity",
            "Hide >=5 Editor WebViews for 10 minutes; verify identity, Bridge, dirty state, input",
            native_reason,
        ),
    ]
    lifecycle = [
        _matrix_entry("window-reconstruction-10x", "Window reconstruction x10", native_reason),
        _matrix_entry(
            "quit-relaunch-5x",
            "Quit/relaunch x5 with >=2 Agents and >=2 live Workspace tmux sessions",
            native_reason,
        ),
    ]
    crashes = [
        _matrix_entry(
            "managed-openvscode",
            "Crash managed OpenVSCode; verify isolation and recovery",
            "Pinned OpenVSCode bundle is unavailable.",
        ),
        _matrix_entry(
            "herdr-connection-or-server",
            "Independently crash Herdr path; verify isolation and recovery",
            "Run the real Herdr check; result is preserved in provider_checks when --execute is used.",
        ),
        _matrix_entry(
            "owned-tmux-session",
            "Independently crash one owned tmux session; verify isolation and recovery",
            "Run the real tmux transition/PTY checks; result is preserved in provider_checks when --execute is used.",
        ),
    ]
    if provider_checks.get("herdr_real_runtime", {}).get("status") == "pass":
        crashes[1].update({"status": "covered", "isolation_verified": True, "recovery_verified": True})
    if provider_checks.get("tmux_transition_matrix", {}).get("status") == "pass" and provider_checks.get(
        "tmux_pty_continuity", {}
    ).get("status") == "pass":
        crashes[2].update({"status": "covered", "isolation_verified": True, "recovery_verified": True})

    return {
        "schema_version": SCHEMA_VERSION,
        "gate": GATE,
        "recorded_at_utc": datetime_module.datetime.now(datetime_module.timezone.utc)
        .replace(microsecond=0)
        .isoformat(),
        "sample_policy": {
            "setup_runs": SETUP_RUNS,
            "measured_runs": MEASURED_RUNS,
            "percentile": "nearest_rank_p95",
            "raw_samples_preserved": True,
        },
        "environment": host,
        "timing_runs": timing_runs,
        "scale_endurance": scale,
        "lifecycle": lifecycle,
        "crash_matrix": crashes,
        "provider_checks": provider_checks,
        "blockers": blockers,
        "redaction": {
            "machine_identifiers": "omitted",
            "absolute_paths": "omitted",
            "unbounded_process_output": "omitted",
        },
    }


def _walk(value: Any, location: str = "report") -> list[tuple[str, str, Any]]:
    found: list[tuple[str, str, Any]] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            key_text = str(key)
            found.extend(_walk(child, f"{location}.{key_text}"))
            found.append((f"{location}.{key_text}", key_text.lower(), child))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(_walk(child, f"{location}[{index}]"))
    elif isinstance(value, str):
        found.append((location, "", value))
    return found


def validate_report(report: Mapping[str, Any]) -> None:
    if report.get("schema_version") != SCHEMA_VERSION or report.get("gate") != GATE:
        raise NativeReportError("native report schema/gate mismatch")
    policy = report.get("sample_policy")
    if not isinstance(policy, Mapping) or policy.get("setup_runs") != SETUP_RUNS or policy.get("measured_runs") != MEASURED_RUNS:
        raise NativeReportError("native sample policy drifted")
    timings = report.get("timing_runs")
    if not isinstance(timings, Mapping) or set(timings) != set(TIMING_IDS):
        raise NativeReportError("native timing scenario set drifted")
    for timing_id in TIMING_IDS:
        entry = timings[timing_id]
        if not isinstance(entry, Mapping):
            raise NativeReportError(f"timing entry missing: {timing_id}")
        if entry.get("setup_runs") != SETUP_RUNS or entry.get("measured_runs") != MEASURED_RUNS:
            raise NativeReportError(f"timing run count missing: {timing_id}")
        samples = entry.get("samples_ms")
        if not isinstance(samples, list) or len(samples) not in (0, MEASURED_RUNS):
            raise NativeReportError(f"timing sample count invalid: {timing_id}")
        if any(not isinstance(sample, (int, float)) or sample < 0 for sample in samples):
            raise NativeReportError(f"timing sample invalid: {timing_id}")
        if samples and entry.get("p95_ms") != nearest_rank_p95(samples):
            raise NativeReportError(f"timing p95 missing or incorrect: {timing_id}")
    if report.get("redaction", {}).get("machine_identifiers") != "omitted":
        raise NativeReportError("machine identifiers must be omitted")
    for location, key, value in _walk(report):
        if key in FORBIDDEN_KEYS:
            raise NativeReportError(f"forbidden field at {location}")
        if isinstance(value, str) and (value.startswith("/") or "/Users/" in value or "/home/" in value):
            raise NativeReportError(f"absolute path leaked at {location}")


def write_report(path: Path, report: Mapping[str, Any]) -> None:
    validate_report(report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def self_test() -> None:
    host = {
        "platform": {"os": "Darwin", "os_release": "local", "architecture": "arm64"},
        "toolchain": {},
        "artifacts": {
            "devhub_debug_binary": "missing",
            "openvscode": {"status": "missing", "source": "not_found", "pinned_identity": "not_verified"},
        },
        "gui": {"window_server": "unavailable", "accessibility": "unavailable", "interactive_session": False},
        "reference_context": "not_proven",
        "machine_identifiers": "omitted",
        "ambient_paths": "omitted",
    }
    report = execute(host, None, run_providers=False)
    validate_report(report)
    report["timing_runs"]["process_cold_shell"]["samples_ms"] = [1.0] * 9
    try:
        validate_report(report)
    except NativeReportError:
        return
    raise NativeReportError("self-test accepted nine samples")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true", help="probe host/artifacts and write a report")
    mode.add_argument("--execute", action="store_true", help="run real app/provider attempts")
    mode.add_argument("--check", action="store_true", help="validate an existing native report")
    mode.add_argument("--self-test", action="store_true", help="run redaction/count self-tests")
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "evidence" / "q5.2-native-report.json")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--skip-providers", action="store_true", help="do not run real provider checks")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.self_test:
            self_test()
            print("Q5.2 native driver self-test: PASS")
            return 0
        if args.check:
            report_path = args.report or args.output
            value = json.loads(report_path.read_text(encoding="utf-8"))
            if not isinstance(value, Mapping):
                raise NativeReportError("native report must be an object")
            validate_report(value)
            print(f"Q5.2 native report valid: {report_path.name}")
            return 0
        host, openvscode = probe_host()
        report = execute(host, openvscode, run_providers=args.execute and not args.skip_providers)
        write_report(args.output, report)
        print(f"Q5.2 native report written: {args.output.name}")
        return 0
    except (NativeReportError, OSError, json.JSONDecodeError) as error:
        print(f"q5.2 native driver: {error}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
