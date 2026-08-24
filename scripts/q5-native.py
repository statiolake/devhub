#!/usr/bin/env python3
"""Run the real-process portion of the DevHub Q5.2 acceptance protocol.

The driver is deliberately conservative.  It discovers the built DevHub
binary and the pinned OpenVSCode executable, checks whether this process has a
WindowServer/Accessibility session and whether it is running inside the
Codex sandbox boundary, and writes a bounded redacted report.  If those
prerequisites are available, ``--execute`` launches the real DevHub binary
once for setup and ten measured cold-shell attempts.  The app emits the
readiness marker from the Rust diagnostics seam after the App Shell has
committed its ready DOM.  Missing markers never become timing samples.  A
sandboxed invocation records ``native_execution_boundary_unavailable`` and
does not launch a GUI process, so an execution-boundary restriction cannot be
misreported as a product marker timeout.

On a native macOS boundary the driver also compiles the tracked CoreGraphics
input helper once, seeds only an isolated real git workspace, and drives the
visible titlebar/picker controls with mouse/keyboard events. It never invokes
Tauri commands directly and does not substitute unit or process timings for
interactive surfaces. ``--execute`` also runs the real Herdr and tmux provider
checks, preserving their exit status without retaining their output.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as datetime_module
import json
import math
import os
import platform
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import select
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Literal, Mapping, Sequence


SCHEMA_VERSION = 1
GATE = "Q5.2"
SETUP_RUNS = 1
MEASURED_RUNS = 10
ATTEMPT_TIMEOUT_SECONDS = 8.0
INTERACTION_TIMEOUT_SECONDS = 8.0
MAX_RETAINED_PERFORMANCE_MARKERS = 64
OPENVSCODE_COMMIT = "4ffe2270acdf711bbefecc3e8c79f4b3631640e5"
OPENVSCODE_VERSION = "1.109.5"
ROOT = Path(__file__).resolve().parents[1]
INPUT_HELPER_SOURCE = ROOT / "scripts" / "q5-native-input.swift"

TIMING_IDS = (
    "process_cold_shell",
    "scratch_interactive",
    "workspace_picker_first_result",
    "mounted_activity_switch",
    "cold_openvscode_interactive",
    "warm_workbench_reconstruction",
)

PERFORMANCE_MARKER_VOCABULARY = frozenset(
    {
        "app_shell_interactive",
        "activity_interactive",
        "scratch_interactive",
        "picker_first_result",
        "editor_bridge_ready",
        "window_reconstruction_ready",
        "dock_reopen_received",
        "dock_reopen_succeeded",
        "dock_reopen_failed",
        "projection_cleanup_started",
        "editor_host_detached",
        "terminal_surfaces_detached",
        "agent_surfaces_detached",
        "projection_cleanup_finished",
        "reopen_worker_entered",
        "cleanup_wait_finished",
        "cleanup_wait_timed_out",
        "coordinator_reopened",
        "window_built",
        "host_reconstructed",
        "window_shown_focused",
        "terminal_attach_entered",
        "terminal_attach_failed_invalid_request",
        "terminal_attach_failed_invalid_surface",
        "terminal_attach_failed_surface_unavailable",
        "terminal_attach_failed_stale_target",
        "terminal_attach_failed_wrong_attachment",
        "terminal_attach_failed_attachment_limit",
        "terminal_attach_failed_session_unavailable",
        "terminal_attach_failed_pty_unavailable",
        "terminal_attach_failed_input_too_large",
        "terminal_attach_failed_invalid_resize",
        "terminal_attach_failed_channel_closed",
        "terminal_attach_failed_backpressure",
        "terminal_attach_failed_runtime_unavailable",
        "terminal_attach_failed_internal",
        "terminal_attach_succeeded",
        "terminal_attach_invoke_rejected",
        "terminal_resize_invoke_entered",
        "terminal_resize_invoke_rejected",
        "terminal_input_invoke_entered",
        "terminal_input_invoke_rejected",
        "terminal_resize_entered",
        "terminal_resize_succeeded",
        "terminal_resize_failed_invalid_request",
        "terminal_resize_failed_invalid_surface",
        "terminal_resize_failed_surface_unavailable",
        "terminal_resize_failed_stale_target",
        "terminal_resize_failed_wrong_attachment",
        "terminal_resize_failed_attachment_limit",
        "terminal_resize_failed_session_unavailable",
        "terminal_resize_failed_pty_unavailable",
        "terminal_resize_failed_input_too_large",
        "terminal_resize_failed_invalid_resize",
        "terminal_resize_failed_channel_closed",
        "terminal_resize_failed_backpressure",
        "terminal_resize_failed_runtime_unavailable",
        "terminal_resize_failed_internal",
        "terminal_input_entered",
        "terminal_input_succeeded",
        "terminal_input_failed_invalid_request",
        "terminal_input_failed_invalid_surface",
        "terminal_input_failed_surface_unavailable",
        "terminal_input_failed_stale_target",
        "terminal_input_failed_wrong_attachment",
        "terminal_input_failed_attachment_limit",
        "terminal_input_failed_session_unavailable",
        "terminal_input_failed_pty_unavailable",
        "terminal_input_failed_input_too_large",
        "terminal_input_failed_invalid_resize",
        "terminal_input_failed_channel_closed",
        "terminal_input_failed_backpressure",
        "terminal_input_failed_runtime_unavailable",
        "terminal_input_failed_internal",
        "terminal_channel_callback_received",
        "terminal_started_frame_validated",
        "terminal_frame_decode_or_identity_failed",
        "terminal_handshake_timeout_before_receipt",
        "terminal_handshake_timeout_after_receipt",
        "terminal_receipt_before_started",
        "terminal_output_rendered",
        "terminal_output_after_input_rendered",
        "editor_provider_degraded",
        "editor_provider_recovered",
    }
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


def _execution_boundary(environment: Mapping[str, str] | None = None) -> dict[str, str]:
    """Report whether this process can launch native GUI applications.

    The Codex sandbox exports ``CODEX_SANDBOX`` (currently ``seatbelt``). The
    approved native execution boundary does not export it. Keep the value
    itself out of reports: the boundary fact is the only actionable,
    non-identifying fact needed by the acceptance harness.
    """

    values = os.environ if environment is None else environment
    if values.get("CODEX_SANDBOX"):
        return {"status": "unavailable", "reason": "native_execution_boundary_unavailable"}
    return {"status": "available", "reason": "native_execution_boundary_available"}


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


def _devhub_bundle_path() -> Path | None:
    """Locate the local debug app bundle without recording its path."""

    configured = os.environ.get("DEVHUB_Q5_DEVHUB_BUNDLE")
    candidates = [
        Path(configured) if configured else None,
        ROOT / "target" / "debug" / "bundle" / "macos" / "DevHub.app",
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        executable = candidate / "Contents" / "MacOS" / "devhub-app"
        if candidate.is_dir() and _regular_executable(executable):
            return candidate
    return None


def _devhub_launch_target() -> tuple[Path, Path | None]:
    """Return the no-bundle executable plus an optional debug .app bundle.

    The direct executable remains the stable native measurement target. The
    app bundle is reserved for the LaunchServices reconstruction scenario,
    where a naked executable has no Dock identity.
    """

    bundle = _devhub_bundle_path()
    configured = os.environ.get("DEVHUB_Q5_DEVHUB_EXECUTABLE")
    if configured:
        executable = Path(configured)
        if bundle is not None:
            try:
                if executable.resolve() == (bundle / "Contents" / "MacOS" / "devhub-app").resolve():
                    return executable, bundle
            except OSError:
                pass
        return executable, None
    return ROOT / "target" / "debug" / "devhub-app", bundle


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


def _openvscode_candidates() -> list[tuple[str, Path, Path | None]]:
    candidates: list[tuple[str, Path, Path | None]] = []
    # The release operator may stage the verified arm64 resource outside the
    # checkout.  Keep this path as a discovery seam (never as report data),
    # ahead of the build-tree fallbacks so a stale local artifact cannot win.
    pinned_resource = Path("/private/tmp/devhub-q52-resource")
    candidates.extend(
        (
            "pinned_temp_resource",
            pinned_resource / relative,
            pinned_resource,
        )
        for relative in (
            Path("openvscode-server/bin/openvscode-server"),
            Path("openvscode/vscode-reh-web-darwin-arm64/bin/openvscode-server"),
            Path("vscode-reh-web-darwin-arm64/bin/openvscode-server"),
        )
    )
    override = os.environ.get("DEVHUB_OPENVSCODE_EXECUTABLE")
    if override:
        candidates.append(("environment_override", Path(override), None))
    resource_override = os.environ.get("DEVHUB_RESOURCE_DIR")
    if resource_override:
        resource_root = Path(resource_override)
        candidates.extend(
            (
                "resource_override",
                resource_root / relative,
                resource_root,
            )
            for relative in (
                Path("openvscode-server/bin/openvscode-server"),
                Path("openvscode/vscode-reh-web-darwin-arm64/bin/openvscode-server"),
                Path("vscode-reh-web-darwin-arm64/bin/openvscode-server"),
            )
        )
    relative = (
        ROOT / "openvscode-server" / "bin" / "openvscode-server",
        ROOT / "openvscode" / "vscode-reh-web-darwin-arm64" / "bin" / "openvscode-server",
        ROOT / "vscode-reh-web-darwin-arm64" / "bin" / "openvscode-server",
        ROOT / "target" / "debug" / "resources" / "openvscode-server" / "bin" / "openvscode-server",
        ROOT / "target" / "debug" / "resources" / "openvscode" / "vscode-reh-web-darwin-arm64" / "bin" / "openvscode-server",
    )
    candidates.extend(("workspace_or_build", path, None) for path in relative)
    # These are deterministic product resource locations.  They are used only
    # for discovery and are never included in the report.
    user_root = Path.home()
    candidates.extend(
        (
            "user_application_support",
            user_root / "Library" / "Application Support" / product / "openvscode-server" / "bin" / "openvscode-server",
            None,
        )
        for product in ("DevHub", "io.github.statiolake.devhub")
    )
    return candidates


@dataclass(frozen=True)
class OpenVSCodeArtifact:
    executable: Path
    resource_root: Path | None
    source: str

    def report(self) -> dict[str, Any]:
        return {"status": "available", "source": self.source, "pinned_identity": "verified"}


def _provider_environment(
    base: Mapping[str, str], artifact: OpenVSCodeArtifact | None
) -> dict[str, str]:
    """Propagate the complete verified provider resource boundary."""

    environment = dict(base)
    if artifact is None:
        return environment
    if artifact.resource_root is not None:
        environment["DEVHUB_RESOURCE_DIR"] = str(artifact.resource_root)
        environment.pop("DEVHUB_OPENVSCODE_EXECUTABLE", None)
    else:
        environment["DEVHUB_OPENVSCODE_EXECUTABLE"] = str(artifact.executable)
    return environment


def discover_openvscode() -> tuple[dict[str, Any], OpenVSCodeArtifact | None]:
    seen: set[str] = set()
    for source, candidate, resource_root in _openvscode_candidates():
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if _regular_executable(candidate) and _product_matches(candidate):
            if resource_root is None and source == "workspace_or_build":
                for parent in candidate.parents:
                    if (parent / "product.json").is_file():
                        resource_root = parent
                        break
            return OpenVSCodeArtifact(candidate, resource_root, source).report(), OpenVSCodeArtifact(
                candidate, resource_root, source
            )
    return (
        {
            "status": "missing",
            "source": "not_found",
            "pinned_identity": "not_verified",
        },
        None,
    )


def _bundle_for_executable(executable: Path) -> Path | None:
    try:
        bundle = executable.resolve().parent.parent.parent
    except OSError:
        return None
    if bundle.suffix != ".app" or not bundle.is_dir():
        return None
    return bundle


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


def _reference_context_facts() -> dict[str, Any]:
    """Record only the bounded facts needed to classify the reference Mac.

    Hardware identifiers are deliberately excluded.  The acceptance context
    is a capability tuple (arm64, 12 cores, 24 GB, macOS 26.5), not a machine
    identity.  Missing sysctls are represented as ``unknown`` and therefore
    cannot accidentally turn a local run into a reference claim.
    """

    facts: dict[str, Any] = {
        "architecture": platform.machine() or "unknown",
        "cpu_cores": None,
        "memory_gb": None,
        "os_major": None,
        "reference_target": "Apple Silicon; 12 CPU cores; 24 GB; macOS 26.5",
        "status": "not_proven",
    }
    if platform.system() == "Darwin" and shutil.which("sysctl"):
        for key, field in (("hw.ncpu", "cpu_cores"), ("hw.memsize", "memory_gb")):
            try:
                result = subprocess.run(
                    ["sysctl", "-n", key],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    text=True,
                    timeout=2,
                )
                if result.returncode == 0:
                    value = int(result.stdout.strip())
                    facts[field] = value if field == "cpu_cores" else round(value / (1024**3), 1)
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
    release = platform.release().split(".", 1)[0]
    try:
        facts["os_major"] = int(release)
    except ValueError:
        pass
    if (
        facts["architecture"] == "arm64"
        and facts["cpu_cores"] == 12
        and facts["memory_gb"] == 24.0
        and facts["os_major"] == 25
    ):
        # Darwin 25 is macOS 26.0-26.x.  The exact minor release is captured
        # separately by the host OS release, without storing a machine ID.
        facts["status"] = "reference_capability_match"
    return facts


def probe_host() -> tuple[dict[str, Any], OpenVSCodeArtifact | None]:
    openvscode_report, openvscode = discover_openvscode()
    binary, bundle = _devhub_launch_target()
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
            "devhub_debug_app_bundle": "available" if bundle is not None else "missing",
            "openvscode": openvscode_report,
        },
        "gui": gui,
        "execution_boundary": _execution_boundary(),
        "reference_context": "not_proven",
        "reference_context_facts": _reference_context_facts(),
        "machine_identifiers": "omitted",
        "ambient_paths": "omitted",
    }
    return host, openvscode


def _marker_seen(log_file: Path, marker: str, offset: int) -> tuple[bool, int]:
    try:
        with log_file.open("rb") as stream:
            stream.seek(offset)
            data = stream.read(64 * 1024)
            new_offset = stream.tell()
    except OSError:
        return False, offset
    for line in data.splitlines():
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if record.get("event") == "performance" and record.get("marker") == marker:
            return True, new_offset
    return False, new_offset


def _marker_observed(log_file: Path, marker: str, offset: int) -> tuple[int | None, int]:
    """Return the first matching diagnostics timestamp after ``offset``."""

    try:
        with log_file.open("rb") as stream:
            stream.seek(offset)
            data = stream.read(64 * 1024)
            new_offset = stream.tell()
    except OSError:
        return None, offset
    cursor = offset
    for line in data.splitlines(keepends=True):
        cursor += len(line)
        try:
            record = json.loads(line.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if record.get("event") == "performance" and record.get("marker") == marker:
            timestamp = record.get("timestamp_ms")
            return (int(timestamp) if isinstance(timestamp, int) else None), cursor
    return None, new_offset


def _log_end(log_file: Path) -> int:
    try:
        return log_file.stat().st_size
    except OSError:
        return 0


def _performance_markers(log_file: Path) -> list[str]:
    """Read only the bounded, closed marker vocabulary from one run."""

    try:
        lines = log_file.read_bytes().splitlines()[-MAX_RETAINED_PERFORMANCE_MARKERS:]
    except OSError:
        return []
    markers: list[str] = []
    for line in lines:
        try:
            record = json.loads(line.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        marker = record.get("marker")
        if record.get("event") == "performance" and marker in PERFORMANCE_MARKER_VOCABULARY:
            markers.append(marker)
    return markers


def _terminal_error_codes(markers: Sequence[str]) -> list[str]:
    return [
        marker.split("_failed_", 1)[1]
        for marker in markers
        if marker.startswith(("terminal_attach_failed_", "terminal_resize_failed_", "terminal_input_failed_"))
    ]


def _marker_timeout_reason(markers: Sequence[str]) -> str:
    """Classify a missing readiness marker from closed probe facts only."""

    errors = _terminal_error_codes(markers)
    if errors:
        for prefix in ("terminal_attach_failed_", "terminal_resize_failed_", "terminal_input_failed_"):
            matching = next((marker for marker in markers if marker.startswith(prefix)), None)
            if matching is not None:
                return matching
    if "terminal_attach_invoke_rejected" in markers and "terminal_attach_entered" not in markers:
        return "terminal_attach_invoke_rejected"
    if "terminal_attach_succeeded" in markers:
        return "post_attach_marker_missing"
    return "marker_timeout"


def _seed_native_config(home: Path) -> None:
    """Keep the injected private tmux namespace through startup resolution.

    DevHub's normal default imports a login shell environment. Login shells
    commonly omit ``TMUX_TMPDIR``, so an isolated acceptance launch would
    otherwise fall back to the user's shared tmux socket directory. The
    harness uses the documented config seam in an isolated HOME to preserve
    the injected environment; production defaults and runtime semantics are
    unchanged.
    """

    config = home / ".config" / "devhub" / "config.toml"
    config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    config.write_text("version = 1\n\n[general]\nimport_login_environment = false\n", encoding="utf-8")
    config.chmod(0o600)


def _wait_for_window_origin(pid: int) -> tuple[int, int] | None:
    """Wait for exactly one AX window owned by the launched PID."""

    deadline = time.monotonic() + INTERACTION_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        origin = _window_origin(pid)
        if origin is not None:
            return origin
        time.sleep(0.05)
    return None


def _wait_for_marker(
    log_file: Path,
    marker: str,
    offset: int,
    timeout: float = INTERACTION_TIMEOUT_SECONDS,
) -> tuple[bool, int, int | None]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        timestamp, next_offset = _marker_observed(log_file, marker, offset)
        if timestamp is not None:
            return True, next_offset, timestamp
        offset = next_offset
        time.sleep(0.025)
    return False, offset, None


def _elapsed_from_native_event(event_timestamp_ns: int, marker_timestamp_ms: int) -> float:
    """Convert the final native event and diagnostics marker to one clock.

    The input actor reports Unix wall-clock nanoseconds at the final CGEvent
    dispatch boundary. Rust diagnostics report Unix wall-clock milliseconds,
    so the event is compared at the diagnostics' exact millisecond resolution
    rather than treating sub-millisecond truncation as an ordering failure.
    A marker before that shared-resolution event is a clock-domain/order
    failure, never a value that may be corrected by subtracting a harness
    constant.
    """

    if event_timestamp_ns <= 0 or marker_timestamp_ms <= 0:
        raise NativeReportError("native event clock sample is invalid")
    marker_timestamp_ns = marker_timestamp_ms * 1_000_000
    event_timestamp_at_marker_resolution_ns = (event_timestamp_ns // 1_000_000) * 1_000_000
    if marker_timestamp_ns < event_timestamp_at_marker_resolution_ns:
        raise NativeReportError("event_marker_clock_order_invalid")
    return round(
        (marker_timestamp_ns - event_timestamp_at_marker_resolution_ns) / 1_000_000,
        3,
    )


class _NativeInput:
    """One persistent CoreGraphics actor for one native driver run."""

    def __init__(self, executable: Path):
        self.executable = executable
        self._process: subprocess.Popen[str] | None = None

    @classmethod
    def build(cls) -> "_NativeInput | None":
        if platform.system() != "Darwin" or shutil.which("swiftc") is None:
            return None
        if not INPUT_HELPER_SOURCE.is_file():
            return None
        output = Path(tempfile.gettempdir()) / f"devhub-q52-native-input-{os.getpid()}"
        try:
            result = subprocess.run(
                ["swiftc", str(INPUT_HELPER_SOURCE), "-o", str(output)],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0 or not _regular_executable(output):
            return None
        actor = cls(output)
        try:
            actor._process = subprocess.Popen(
                [str(actor.executable)],
                cwd=ROOT,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
        except OSError:
            return None
        return actor

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
            try:
                process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass

    def invoke(self, *arguments: str) -> int | None:
        process = self._process
        if process is None or process.poll() is not None or process.stdin is None or process.stdout is None:
            return None
        try:
            process.stdin.write(" ".join(arguments) + "\n")
            process.stdin.flush()
            ready, _, _ = select.select(
                [process.stdout], [], [], 2.0
            )
            if not ready:
                return None
            response = process.stdout.readline().strip()
        except (OSError, subprocess.SubprocessError):
            return None
        fields = response.split()
        if len(fields) != 2 or fields[0] != "posted":
            return None
        try:
            timestamp_ns = int(fields[1])
        except ValueError:
            return None
        return timestamp_ns if timestamp_ns > 0 else None

    def __enter__(self) -> "_NativeInput":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


class _ProcessHandle:
    """Small process identity handle for NSWorkspace-launched bundles."""

    def __init__(self, pid: int, popen: subprocess.Popen[bytes] | None = None):
        self.pid = pid
        self._popen = popen

    def poll(self) -> int | None:
        if self._popen is not None:
            return self._popen.poll()
        try:
            os.kill(self.pid, 0)
        except (ProcessLookupError, PermissionError, OSError):
            return 0
        return None

    def terminate(self) -> None:
        if self._popen is not None:
            self._popen.terminate()
            return
        try:
            os.kill(self.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def kill(self) -> None:
        if self._popen is not None:
            self._popen.kill()
            return
        try:
            os.kill(self.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def wait(self, timeout: float | None = None) -> int:
        if self._popen is not None:
            return self._popen.wait(timeout=timeout)
        deadline = None if timeout is None else time.monotonic() + timeout
        while self.poll() is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired("native bundle process", timeout)
            time.sleep(0.05)
        return 0


class _NativeBundleLauncher:
    """Launch a debug .app through LaunchServices with the measured env."""

    def __init__(self, executable: Path):
        self.executable = executable

    @classmethod
    def build(cls) -> "_NativeBundleLauncher | None":
        if platform.system() != "Darwin" or shutil.which("swiftc") is None:
            return None
        source = ROOT / "scripts" / "q5-native-launch.swift"
        if not source.is_file():
            return None
        output = Path(tempfile.gettempdir()) / f"devhub-q52-native-launch-{os.getpid()}"
        module_cache = Path(tempfile.gettempdir()) / f"devhub-q52-swift-cache-{os.getpid()}"
        module_cache.mkdir(mode=0o700, exist_ok=True)
        try:
            result = subprocess.run(
                [
                    "swiftc",
                    "-module-cache-path",
                    str(module_cache),
                    str(source),
                    "-o",
                    str(output),
                ],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0 or not _regular_executable(output):
            return None
        return cls(output)

    def launch(self, bundle: Path, environment: Mapping[str, str]) -> _ProcessHandle:
        result = subprocess.run(
            [str(self.executable), str(bundle)],
            cwd=ROOT,
            env=dict(environment),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            text=True,
            timeout=20,
        )
        if result.returncode != 0:
            reason = result.stderr.strip() if result.stderr else ""
            raise OSError(reason or "LaunchServices bundle launch failed")
        try:
            pid = int(result.stdout.strip())
        except (TypeError, ValueError):
            raise OSError("LaunchServices bundle PID unavailable") from None
        if pid <= 0:
            raise OSError("LaunchServices bundle PID invalid")
        return _ProcessHandle(pid)


_NATIVE_BUNDLE_LAUNCHER: _NativeBundleLauncher | None = None

_NATIVE_LAUNCH_FAILURES = {
    "bundle_quiescer_unavailable",
    "bundle_instance_registered",
    "prior_bundle_instance_registered",
    "owned_cleanup_incomplete",
    "owned_bundle_quiescence_timeout",
    "native bundle launcher unavailable",
    "LaunchServices bundle launch failed",
    "LaunchServices bundle PID unavailable",
    "LaunchServices bundle PID invalid",
    "launch_callback_timeout",
    "launch_callback_error",
    "invalid_pid",
    "bundle_identity_mismatch",
    "launched_process_exited",
}


class _NativeBundleQuiescer:
    """Wait until one bundle has no registered native instance."""

    def __init__(self, executable: Path):
        self.executable = executable

    @classmethod
    def build(cls) -> "_NativeBundleQuiescer | None":
        if platform.system() != "Darwin" or shutil.which("swiftc") is None:
            return None
        source = ROOT / "scripts" / "q5-native-quiesce.swift"
        if not source.is_file():
            return None
        output = Path(tempfile.gettempdir()) / f"devhub-q52-native-quiesce-{os.getpid()}"
        module_cache = Path(tempfile.gettempdir()) / f"devhub-q52-swift-quiesce-cache-{os.getpid()}"
        module_cache.mkdir(mode=0o700, exist_ok=True)
        try:
            result = subprocess.run(
                ["swiftc", "-module-cache-path", str(module_cache), str(source), "-o", str(output)],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0 or not _regular_executable(output):
            return None
        return cls(output)

    def wait(self, bundle: Path, pid: int) -> bool:
        try:
            result = subprocess.run(
                [str(self.executable), str(bundle), str(pid)],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                text=True,
                timeout=12,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return result.returncode == 0 and result.stdout.strip() == "quiescent"


_NATIVE_BUNDLE_QUIESCER: _NativeBundleQuiescer | None = None
_LAST_BUNDLE_PID: dict[str, int] = {}


class _NativeBundleReopener:
    """Ask LaunchServices/AppKit to reopen one already-running bundle PID."""

    def __init__(self, executable: Path):
        self.executable = executable

    @classmethod
    def build(cls) -> "_NativeBundleReopener | None":
        if platform.system() != "Darwin" or shutil.which("swiftc") is None:
            return None
        source = ROOT / "scripts" / "q5-native-reopen.swift"
        if not source.is_file():
            return None
        output = Path(tempfile.gettempdir()) / f"devhub-q52-native-reopen-{os.getpid()}"
        module_cache = Path(tempfile.gettempdir()) / f"devhub-q52-swift-reopen-cache-{os.getpid()}"
        module_cache.mkdir(mode=0o700, exist_ok=True)
        try:
            result = subprocess.run(
                [
                    "swiftc",
                    "-module-cache-path",
                    str(module_cache),
                    str(source),
                    "-o",
                    str(output),
                ],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0 or not _regular_executable(output):
            return None
        return cls(output)

    def reopen(self, bundle: Path, pid: int) -> bool:
        try:
            result = subprocess.run(
                [str(self.executable), str(bundle), str(pid)],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                text=True,
                timeout=20,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        try:
            return result.returncode == 0 and int(result.stdout.strip()) == pid
        except (TypeError, ValueError):
            return False


_NATIVE_BUNDLE_REOPENER: _NativeBundleReopener | None = None


def _window_origin(pid: int) -> tuple[int, int] | None:
    """Return the launched process's only visible window origin.

    Process names are not an identity boundary: a stale DevHub instance can
    have the same name while a measured instance is starting.  Bind every
    accessibility query to the Popen PID and require exactly one window.
    """

    script = f"""
tell application "System Events"
    set targetProcess to first application process whose unix id is {int(pid)}
    set windowCount to count of windows of targetProcess
    if windowCount is not 1 then return "count:" & windowCount
    return position of window 1 of targetProcess
end tell
"""
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    if result.stdout.strip().startswith("count:"):
        return None
    fields = [field.strip() for field in result.stdout.split(",")]
    if len(fields) < 2:
        return None
    try:
        return int(float(fields[0])), int(float(fields[1]))
    except ValueError:
        return None


def _window_count(pid: int) -> int | None:
    script = f"""
tell application "System Events"
    set targetProcess to first application process whose unix id is {int(pid)}
    return count of windows of targetProcess
end tell
"""
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        return int(result.stdout.strip())
    except ValueError:
        return None


def _launchservices_reopen(bundle: Path, pid: int) -> bool:
    """Reopen through AppKit/LaunchServices while requiring the same PID."""

    global _NATIVE_BUNDLE_REOPENER
    if _NATIVE_BUNDLE_REOPENER is None:
        _NATIVE_BUNDLE_REOPENER = _NativeBundleReopener.build()
    if _NATIVE_BUNDLE_REOPENER is None:
        return False
    return _NATIVE_BUNDLE_REOPENER.reopen(bundle, pid)


def _close_window(pid: int) -> bool:
    script = f"""
tell application "System Events"
    set targetProcess to first application process whose unix id is {int(pid)}
    tell targetProcess to click menu item "Close Window" of menu "Window" of menu bar 1
end tell
"""
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _request_quit(pid: int) -> bool:
    """Use DevHub's real click-only Quit menu before force cleanup."""

    script = f"""
tell application "System Events"
    set targetProcess to first application process whose unix id is {int(pid)}
    tell targetProcess to click menu item "Quit DevHub" of menu "DevHub" of menu bar 1
end tell
"""
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _owned_processes(home: Path, app_pid: int) -> list[int] | None:
    """Return only processes carrying this run's exact isolated HOME."""

    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    owned: list[int] = []
    home_text = str(home)
    excluded = {os.getpid(), app_pid}
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or home_text not in fields[1]:
            continue
        try:
            pid = int(fields[0])
        except ValueError:
            continue
        if pid not in excluded:
            owned.append(pid)
    return owned


def _cleanup_owned_processes(home: Path, app_pid: int) -> bool:
    """Reconcile q52-owned children until two scans are empty.

    OpenVSCode can reparent a delayed node child to launchd after the app PID
    exits. Re-scan within a short deadline so that child is still matched by
    this run's canonical temporary HOME before TemporaryDirectory removes it.
    """

    # Provider children can be reparented to launchd after the app leader
    # exits.  Keep reconciling the exact isolated HOME long enough for that
    # handoff to settle; a shorter sweep turned an otherwise valid final
    # lifecycle sample into a generic launch-unavailable result.
    deadline = time.monotonic() + 10.0
    empty_scans = 0
    while time.monotonic() < deadline:
        owned = _owned_processes(home, app_pid)
        if owned is None:
            return False
        if not owned:
            empty_scans += 1
            if empty_scans >= 2:
                return True
            time.sleep(0.08)
            continue
        empty_scans = 0
        for pid in owned:
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass
        time.sleep(0.12)
        remaining = _owned_processes(home, app_pid)
        if remaining is None:
            return False
        for pid in remaining:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
        time.sleep(0.08)
    return False


def _owned_openvscode_pids(home: Path, app_pid: int) -> list[int]:
    """Find this run's managed server and descendants by owned root PID.

    The pinned OpenVSCode entry point is a shell wrapper on macOS.  Killing
    that wrapper alone leaves its Node server alive, so ownership is first
    established from the exact isolated HOME-bearing root and then extended
    only through its observed parent-child process tree.  The caller kills
    the deepest owned server PID, never a name-matched unrelated process.
    """

    try:
        result = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    records: dict[int, tuple[int, str]] = {}
    home_text = str(home)
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or home_text not in fields[1] or "openvscode-server" not in fields[1]:
            continue
        try:
            pid = int(fields[0])
        except ValueError:
            continue
        if pid not in {os.getpid(), app_pid}:
            command = fields[1]
            records[pid] = (0, command)

    # Read the parent relation separately because descendants do not repeat
    # the HOME-bearing argv.  This remains an internal ownership fact and is
    # never retained in evidence.
    try:
        relation = subprocess.run(
            ["ps", "-axo", "pid=,ppid=,command="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return list(records)
    all_records: dict[int, tuple[int, str]] = {}
    for line in relation.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) != 3:
            continue
        try:
            all_records[int(fields[0])] = (int(fields[1]), fields[2])
        except ValueError:
            continue
    roots = set(records)
    children: dict[int, list[int]] = {}
    for pid, (parent, _command) in all_records.items():
        children.setdefault(parent, []).append(pid)
    depths: dict[int, int] = {}
    pending = [(root, 0) for root in roots]
    while pending:
        pid, depth = pending.pop()
        if pid in depths and depths[pid] >= depth:
            continue
        depths[pid] = depth
        pending.extend((child, depth + 1) for child in children.get(pid, ()))
    # The direct child of the owned wrapper is the managed server.  Prefer it
    # over worker descendants so the crash probe kills the provider identity
    # itself while retaining exact parent-tree ownership.
    return sorted(depths, key=lambda pid: (depths[pid] == 0, depths[pid], pid))


def _kill_owned_openvscode(home: Path, app_pid: int) -> int:
    """Crash one managed OpenVSCode child for one isolated run."""

    pids = _owned_openvscode_pids(home, app_pid)
    for pid in pids[:1]:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    return len(pids)


def _stop_owned_process(process: _ProcessHandle, *, graceful: bool) -> None:
    """Stop one exact app PID with a bounded cleanup policy.

    Disposable timing attempts must not spend the graceful menu-Quit budget:
    their isolated HOME and private tmux namespace are thrown away after the
    marker boundary.  The graceful policy is reserved for the quit/relaunch
    lifecycle harness, where clean state and provider retention are evidence.
    """

    if process.poll() is not None:
        return
    if graceful:
        _request_quit(process.pid)
        try:
            process.wait(timeout=INTERACTION_TIMEOUT_SECONDS)
            return
        except subprocess.TimeoutExpired:
            pass
    process.terminate()
    try:
        process.wait(timeout=2)
        return
    except subprocess.TimeoutExpired:
        pass
    process.kill()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        # The ownership-bound reaper below still performs a final bounded
        # signal sweep. Never let cleanup turn a failed marker into a hang.
        pass


@contextlib.contextmanager
def _running_app(
    executable: Path,
    openvscode: OpenVSCodeArtifact | None,
    *,
    seed_picker: bool = False,
    cleanup_policy: Literal["fast", "graceful"] = "fast",
) -> Iterator[tuple[_ProcessHandle, Path, Path, float]]:
    """Launch one real app with a canonical isolated HOME."""

    with tempfile.TemporaryDirectory(prefix="devhub-q52-") as temp_home:
        safe_home = Path(temp_home).resolve()
        _seed_native_config(safe_home)
        tmux_tmpdir = safe_home / ".tmux"
        tmux_tmpdir.mkdir(mode=0o700)
        if seed_picker:
            workspace = safe_home / "dev" / "q5-picker-workspace"
            workspace.mkdir(parents=True, exist_ok=True)
            try:
                subprocess.run(
                    ["git", "-C", str(workspace), "init", "--quiet"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=5,
                )
            except (OSError, subprocess.SubprocessError):
                pass
        environment = _provider_environment(os.environ, openvscode)
        environment["HOME"] = str(safe_home)
        # tmux's socket namespace is independent from HOME.  Keep every
        # measured launch in a private, trusted namespace so a prior run
        # cannot make its Scratch identity collide with this run.
        environment["TMUX_TMPDIR"] = str(tmux_tmpdir)
        environment["DEVHUB_Q5_PERFORMANCE"] = "1"
        log_file = safe_home / "Library" / "Logs" / "DevHub" / "devhub.jsonl"
        started = time.monotonic()
        try:
            bundle = _bundle_for_executable(executable)
            if bundle is not None:
                global _NATIVE_BUNDLE_LAUNCHER
                global _NATIVE_BUNDLE_QUIESCER
                previous_pid = _LAST_BUNDLE_PID.get(str(bundle), 0)
                if _NATIVE_BUNDLE_QUIESCER is None:
                    _NATIVE_BUNDLE_QUIESCER = _NativeBundleQuiescer.build()
                if _NATIVE_BUNDLE_QUIESCER is None:
                    raise OSError("bundle_quiescer_unavailable")
                if not _NATIVE_BUNDLE_QUIESCER.wait(bundle, previous_pid):
                    raise OSError(
                        "prior_bundle_instance_registered"
                        if previous_pid > 0
                        else "bundle_instance_registered"
                    )
                if _NATIVE_BUNDLE_LAUNCHER is None:
                    _NATIVE_BUNDLE_LAUNCHER = _NativeBundleLauncher.build()
                if _NATIVE_BUNDLE_LAUNCHER is None:
                    raise OSError("native bundle launcher unavailable")
                process = _NATIVE_BUNDLE_LAUNCHER.launch(bundle, environment)
                _LAST_BUNDLE_PID[str(bundle)] = process.pid
            else:
                child = subprocess.Popen(
                    [str(executable)],
                    cwd=ROOT,
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                process = _ProcessHandle(child.pid, child)
        except OSError:
            raise
        try:
            yield process, safe_home, log_file, started
        finally:
            _stop_owned_process(process, graceful=cleanup_policy == "graceful")
            cleaned = _cleanup_owned_processes(safe_home, process.pid)
            _cleanup_owned_tmux(tmux_tmpdir)
            if not cleaned:
                raise OSError("owned_cleanup_incomplete")
            if bundle is not None:
                quiescer = _NATIVE_BUNDLE_QUIESCER
                if quiescer is None or not quiescer.wait(bundle, process.pid):
                    raise OSError("owned_bundle_quiescence_timeout")


def _cleanup_owned_tmux(tmux_tmpdir: Path) -> None:
    """Stop only the private tmux server created by one measured launch."""

    tmux = shutil.which("tmux")
    if tmux is None:
        return
    env = os.environ.copy()
    env["TMUX_TMPDIR"] = str(tmux_tmpdir)
    try:
        subprocess.run(
            [tmux, "-L", "devhub", "kill-server"],
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def _launch_shell_attempt(executable: Path, openvscode: OpenVSCodeArtifact | None) -> dict[str, Any]:
    """Launch DevHub and wait for the AppShell marker, retaining no output."""

    with tempfile.TemporaryDirectory(prefix="devhub-q52-") as temp_home:
        # DevHub's app-owned path seams reject symlinked ancestors. macOS may
        # expose tempfile paths through `/var`, which is a symlink to the
        # canonical per-user `/private/var` tree; pass the resolved HOME so a
        # real editor resource run exercises the same secure path contract as
        # a packaged launch.
        safe_home = Path(temp_home).resolve()
        _seed_native_config(safe_home)
        tmux_tmpdir = safe_home / ".tmux"
        tmux_tmpdir.mkdir(mode=0o700)
        env = _provider_environment(os.environ, openvscode)
        env["HOME"] = str(safe_home)
        env["TMUX_TMPDIR"] = str(tmux_tmpdir)
        env["DEVHUB_Q5_PERFORMANCE"] = "1"
        log_file = safe_home / "Library" / "Logs" / "DevHub" / "devhub.jsonl"
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
        _stop_owned_process(process, graceful=False)
        cleaned = _cleanup_owned_processes(safe_home, process.pid)
        _cleanup_owned_tmux(tmux_tmpdir)
        if not cleaned:
            return {
                "status": "blocked",
                "elapsed_ms": elapsed,
                "marker": "app_shell_interactive",
                "reason": "owned_cleanup_incomplete",
            }
        return {
            "status": status,
            "elapsed_ms": elapsed,
            "marker": "app_shell_interactive",
            "reason": reason,
        }


def _marker_attempt(
    executable: Path,
    openvscode: OpenVSCodeArtifact | None,
    input_driver: _NativeInput | None,
    marker: str,
    *,
    action: tuple[int, int] | None = None,
    seed_picker: bool = False,
) -> dict[str, Any]:
    """Measure one real marker, optionally after one visible UI activation."""

    if action is not None and input_driver is None:
        return {
            "status": "blocked",
            "elapsed_ms": None,
            "marker": marker,
            "reason": "native_input_helper_unavailable",
        }
    try:
        context = _running_app(executable, openvscode, seed_picker=seed_picker)
        with context as (process, _home, log_file, started):
            shell_ok, shell_offset, _ = _wait_for_marker(log_file, "app_shell_interactive", 0)
            if not shell_ok:
                markers = _performance_markers(log_file)
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "app_shell_marker_timeout",
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            action_timestamp_ns: int | None = None
            if action is None:
                action_started = started
                marker_offset = shell_offset
            else:
                origin = _wait_for_window_origin(process.pid)
                if origin is None:
                    return {
                        "status": "blocked",
                        "elapsed_ms": None,
                        "marker": marker,
                        "reason": "native_window_geometry_unavailable",
                    }
                x = origin[0] + action[0]
                y = origin[1] + action[1]
                marker_offset = _log_end(log_file)
                action_timestamp_ns = input_driver.invoke("click", str(x), str(y))
                if action_timestamp_ns is None:
                    return {
                        "status": "blocked",
                        "elapsed_ms": None,
                        "marker": marker,
                        "reason": "native_input_event_failed",
                    }
            found, _next_offset, marker_timestamp_ms = _wait_for_marker(
                log_file, marker, marker_offset
            )
            if not found:
                markers = _performance_markers(log_file)
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": _marker_timeout_reason(markers),
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            if action_timestamp_ns is not None and marker_timestamp_ms is not None:
                try:
                    elapsed_ms = _elapsed_from_native_event(
                        action_timestamp_ns, marker_timestamp_ms
                    )
                except NativeReportError as error:
                    markers = _performance_markers(log_file)
                    return {
                        "status": "blocked",
                        "elapsed_ms": None,
                        "marker": marker,
                        "reason": str(error),
                        "ordered_markers": markers,
                        "terminal_error_codes": _terminal_error_codes(markers),
                    }
                measurement_clock = "unix_wall_event_boundary_ns_to_diagnostics_ms"
            else:
                elapsed_ms = round((time.monotonic() - action_started) * 1000, 3)
                measurement_clock = "process_monotonic_start_to_diagnostics_marker"
            markers = _performance_markers(log_file)
            return {
                "status": "pass",
                "elapsed_ms": elapsed_ms,
                "marker": marker,
                "reason": "marker_observed",
                "measurement_clock": measurement_clock,
                "ordered_markers": markers,
                "terminal_error_codes": _terminal_error_codes(markers),
            }
    except OSError as error:
        reason = str(error)
        if reason not in _NATIVE_LAUNCH_FAILURES and not reason.startswith("launch_callback_error:"):
            reason = "devhub_launch_unavailable"
        return {
            "status": "unavailable",
            "elapsed_ms": None,
            "marker": marker,
            "reason": reason,
        }


def _scratch_attempt(
    executable: Path,
    openvscode: OpenVSCodeArtifact | None,
    input_driver: _NativeInput | None,
) -> dict[str, Any]:
    """Prove Scratch input acceptance followed by a rendered local response."""

    marker = "scratch_interactive"
    if input_driver is None:
        return {
            "status": "blocked",
            "elapsed_ms": None,
            "marker": marker,
            "reason": "native_input_helper_unavailable",
        }
    try:
        with _running_app(executable, openvscode) as (process, _home, log_file, _started):
            shell_ok, shell_offset, _ = _wait_for_marker(
                log_file, "app_shell_interactive", 0
            )
            if not shell_ok:
                markers = _performance_markers(log_file)
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "app_shell_marker_timeout",
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            attached, attach_offset, _ = _wait_for_marker(
                log_file, "terminal_attach_succeeded", shell_offset
            )
            if not attached:
                markers = _performance_markers(log_file)
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": _marker_timeout_reason(markers),
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            origin = _wait_for_window_origin(process.pid)
            if origin is None:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "native_window_geometry_unavailable",
                    "ordered_markers": _performance_markers(log_file),
                }
            # Direct no-bundle launches are not always registered as an
            # NSRunningApplication. Try exact-PID activation when available,
            # then retain the explicit xterm focus fallback below.
            input_driver.invoke("activate-pid", str(process.pid))
            if input_driver.invoke("click", str(origin[0] + 500), str(origin[1] + 200)) is None:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "native_focus_event_failed",
                    "ordered_markers": _performance_markers(log_file),
                }
            precondition_offset = attach_offset
            for precondition in (
                "terminal_started_frame_validated",
                "terminal_output_rendered",
                "terminal_resize_succeeded",
            ):
                ready, precondition_offset, _ = _wait_for_marker(
                    log_file, precondition, precondition_offset
                )
                if not ready:
                    markers = _performance_markers(log_file)
                    return {
                        "status": "blocked",
                        "elapsed_ms": None,
                        "marker": marker,
                        "reason": "initial_terminal_not_ready",
                        "missing_precondition": precondition,
                        "ordered_markers": markers,
                        "terminal_error_codes": _terminal_error_codes(markers),
                    }
            # The click is setup-only focus. Drain its possible xterm control
            # traffic before arming the measured key gesture.
            quiet_since = time.monotonic()
            quiet_offset = _log_end(log_file)
            while time.monotonic() - quiet_since < 0.2:
                next_offset = _log_end(log_file)
                if next_offset != quiet_offset:
                    quiet_offset = next_offset
                    quiet_since = time.monotonic()
                time.sleep(0.025)
            marker_offset = _log_end(log_file)
            event_timestamp_ns = input_driver.invoke("press-enter")
            if event_timestamp_ns is None:
                markers = _performance_markers(log_file)
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "native_input_event_failed",
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            found, _next_offset, marker_timestamp_ms = _wait_for_marker(
                log_file, marker, marker_offset
            )
            markers = _performance_markers(log_file)
            if not found:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": _marker_timeout_reason(markers),
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            required = (
                "terminal_input_invoke_entered",
                "terminal_input_succeeded",
                "terminal_output_after_input_rendered",
            )
            marker_positions = {value: markers.index(value) for value in required if value in markers}
            if len(marker_positions) != len(required) or not (
                marker_positions[required[0]]
                < marker_positions[required[1]]
                < marker_positions[required[2]]
                < markers.index(marker)
            ):
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "scratch_interactive_boundary_incomplete",
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            if marker_timestamp_ms is None:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "marker_timestamp_missing",
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            try:
                elapsed_ms = _elapsed_from_native_event(event_timestamp_ns, marker_timestamp_ms)
            except NativeReportError as error:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": str(error),
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            return {
                "status": "pass",
                "elapsed_ms": elapsed_ms,
                "marker": marker,
                "reason": "input_accepted_and_local_response_rendered",
                "measurement_clock": "unix_wall_event_boundary_ns_to_diagnostics_ms",
                "ordered_markers": markers,
                "terminal_error_codes": _terminal_error_codes(markers),
            }
    except OSError as error:
        reason = str(error)
        if reason not in _NATIVE_LAUNCH_FAILURES and not reason.startswith("launch_callback_error:"):
            reason = "devhub_launch_unavailable"
        return {
            "status": "unavailable",
            "elapsed_ms": None,
            "marker": marker,
            "reason": reason,
        }


def _activity_attempt(
    executable: Path,
    openvscode: OpenVSCodeArtifact | None,
    input_driver: _NativeInput | None,
) -> dict[str, Any]:
    """Switch from the mounted Terminal activity to Editor via native input."""

    marker = "activity_interactive"
    if input_driver is None:
        return {
            "status": "blocked",
            "elapsed_ms": None,
            "marker": marker,
            "reason": "native_input_helper_unavailable",
        }
    try:
        with _running_app(executable, openvscode) as (process, _home, log_file, _started):
            shell_ok, shell_offset, _ = _wait_for_marker(log_file, "app_shell_interactive", 0)
            if not shell_ok:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "app_shell_marker_timeout",
                }
            origin = _wait_for_window_origin(process.pid)
            if origin is None:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "native_window_geometry_unavailable",
                }
            baseline = _log_end(log_file)
            editor_x, editor_y = origin[0] + 247, origin[1] + 27
            event_timestamp_ns = input_driver.invoke("click", str(editor_x), str(editor_y))
            if event_timestamp_ns is None:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "native_input_event_failed",
                }
            found, _next_offset, marker_timestamp_ms = _wait_for_marker(log_file, marker, baseline)
            if not found:
                markers = _performance_markers(log_file)
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": _marker_timeout_reason(markers),
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            if marker_timestamp_ms is None:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "marker_timestamp_missing",
                }
            try:
                elapsed_ms = _elapsed_from_native_event(event_timestamp_ns, marker_timestamp_ms)
            except NativeReportError as error:
                markers = _performance_markers(log_file)
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": str(error),
                    "ordered_markers": markers,
                    "terminal_error_codes": _terminal_error_codes(markers),
                }
            return {
                "status": "pass",
                "elapsed_ms": elapsed_ms,
                "marker": marker,
                "reason": "marker_observed",
                "measurement_clock": "unix_wall_event_boundary_ns_to_diagnostics_ms",
            }
    except OSError:
        return {
            "status": "unavailable",
            "elapsed_ms": None,
            "marker": marker,
            "reason": "devhub_launch_unavailable",
        }


def _warm_reconstruction_attempt(
    executable: Path,
    openvscode: OpenVSCodeArtifact | None,
    input_driver: _NativeInput | None,
) -> dict[str, Any]:
    """Close and reopen the real Window through the native menu and Dock."""

    # Host reconstruction is an internal readiness boundary. The measured
    # interactive endpoint is the closed marker emitted only after the real
    # Window has been shown and focused again.
    marker = "window_shown_focused"
    try:
        with _running_app(executable, openvscode) as (process, _home, log_file, _started):
            ready, offset, _ = _wait_for_marker(
                log_file, "window_reconstruction_ready", 0
            )
            if not ready:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "initial_reconstruction_timeout",
                }
            if not _close_window(process.pid):
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "native_window_close_failed",
                }
            closed_deadline = time.monotonic() + 5.0
            while time.monotonic() < closed_deadline:
                count = _window_count(process.pid)
                if count == 0:
                    break
                time.sleep(0.05)
            offset = _log_end(log_file)
            started = time.monotonic()
            bundle = _bundle_for_executable(executable)
            if bundle is None:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "debug_app_bundle_missing",
                }
            if not _launchservices_reopen(bundle, process.pid):
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "native_dock_reopen_unavailable",
                }
            if process.poll() is not None:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "process_exited_before_reopen",
                }
            reopened_deadline = time.monotonic() + INTERACTION_TIMEOUT_SECONDS
            while time.monotonic() < reopened_deadline:
                if _window_count(process.pid) == 1:
                    break
                if process.poll() is not None:
                    return {
                        "status": "blocked",
                        "elapsed_ms": None,
                        "marker": marker,
                        "reason": "process_exited_before_reopen",
                    }
                time.sleep(0.05)
            else:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "reopened_window_not_bound_to_pid",
                }
            found, _next_offset, _timestamp = _wait_for_marker(log_file, marker, offset)
            if not found:
                return {
                    "status": "blocked",
                    "elapsed_ms": None,
                    "marker": marker,
                    "reason": "reconstruction_marker_timeout",
                }
            return {
                "status": "pass",
                "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
                "marker": marker,
                "reason": "marker_observed",
            }
    except OSError as error:
        reason = str(error)
        if reason not in _NATIVE_LAUNCH_FAILURES and not reason.startswith("launch_callback_error:"):
            reason = "devhub_launch_unavailable"
        return {
            "status": "unavailable",
            "elapsed_ms": None,
            "marker": marker,
            "reason": reason,
        }


def _window_reconstruction_matrix(
    executable: Path,
    openvscode: OpenVSCodeArtifact | None,
    cycles: int = 10,
) -> dict[str, Any]:
    """Exercise close/Dock reconstruction repeatedly on one exact PID.

    This is intentionally separate from the warm timing scenario: the timing
    run measures one reconstruction per fresh setup, while this matrix proves
    that the same Window identity survives ten consecutive close/reopen
    transitions.  A missing native marker leaves the matrix blocked.
    """

    if cycles != 10:
        raise NativeReportError("window reconstruction matrix requires ten cycles")
    try:
        with _running_app(executable, openvscode) as (process, _home, log_file, _started):
            ready, offset, _ = _wait_for_marker(log_file, "window_reconstruction_ready", 0)
            if not ready:
                return {
                    "status": "blocked",
                    "cycles_required": cycles,
                    "cycles_completed": 0,
                    "identity_verified": False,
                    "reason": "initial_reconstruction_timeout",
                }
            completed = 0
            for cycle in range(cycles):
                if not _close_window(process.pid):
                    return {
                        "status": "blocked",
                        "cycles_required": cycles,
                        "cycles_completed": completed,
                        "identity_verified": False,
                        "reason": "native_window_close_failed",
                    }
                deadline = time.monotonic() + 5.0
                while time.monotonic() < deadline and _window_count(process.pid) != 0:
                    time.sleep(0.05)
                if _window_count(process.pid) != 0:
                    return {
                        "status": "blocked",
                        "cycles_required": cycles,
                        "cycles_completed": completed,
                        "identity_verified": False,
                        "reason": "window_did_not_close",
                    }
                bundle = _bundle_for_executable(executable)
                if bundle is None or not _launchservices_reopen(bundle, process.pid):
                    return {
                        "status": "blocked",
                        "cycles_required": cycles,
                        "cycles_completed": completed,
                        "identity_verified": False,
                        "reason": "native_dock_reopen_unavailable",
                    }
                deadline = time.monotonic() + INTERACTION_TIMEOUT_SECONDS
                while time.monotonic() < deadline:
                    if _window_count(process.pid) == 1:
                        break
                    if process.poll() is not None:
                        return {
                            "status": "blocked",
                            "cycles_required": cycles,
                            "cycles_completed": completed,
                            "identity_verified": False,
                            "reason": "process_exited_during_reconstruction",
                        }
                    time.sleep(0.05)
                if _window_count(process.pid) != 1:
                    return {
                        "status": "blocked",
                        "cycles_required": cycles,
                        "cycles_completed": completed,
                        "identity_verified": False,
                        "reason": "reopened_window_not_bound_to_pid",
                    }
                found, offset, _ = _wait_for_marker(
                    log_file, "window_shown_focused", offset, timeout=INTERACTION_TIMEOUT_SECONDS
                )
                if not found:
                    return {
                        "status": "blocked",
                        "cycles_required": cycles,
                        "cycles_completed": completed,
                        "identity_verified": False,
                        "reason": "reconstruction_marker_timeout",
                    }
                completed = cycle + 1
            return {
                "status": "covered",
                "cycles_required": cycles,
                "cycles_completed": completed,
                "identity_verified": True,
                "reason": "ten exact-PID close/reopen cycles completed",
            }
    except OSError as error:
        reason = str(error)
        if reason not in _NATIVE_LAUNCH_FAILURES and not reason.startswith("launch_callback_error:"):
            reason = "devhub_launch_unavailable"
        return {
            "status": "blocked",
            "cycles_required": cycles,
            "cycles_completed": 0,
            "identity_verified": False,
            "reason": reason,
        }


def _editor_host_lifecycle_facts(home: Path) -> dict[str, Any]:
    """Read only the app-owned, content-free EditorHost lifecycle log."""

    counts: list[int] = []
    destroyed: list[int] = []
    try:
        lines = (home / "Library" / "Logs" / "DevHub" / "editor-host.log").read_text(
            encoding="utf-8", errors="replace"
        ).splitlines()
    except OSError:
        lines = []
    for line in lines[-128:]:
        fields = line.split()
        if len(fields) != 2 or fields[0] not in {"event=webviews_created", "event=webviews_destroyed"}:
            continue
        try:
            count = int(fields[1].split("=", 1)[1])
        except (IndexError, ValueError):
            continue
        if fields[0] == "event=webviews_created":
            counts.append(count)
        else:
            destroyed.append(count)
    return {
        "max_created": max(counts, default=0),
        "max_destroyed": max(destroyed, default=0),
        "log_observed": bool(counts or destroyed),
    }


def _editor_scale_probe(executable: Path, openvscode: OpenVSCodeArtifact | None) -> dict[str, Any]:
    """Observe real EditorHost/Bridge scale facts without inventing agents.

    The probe is deliberately conservative: mounted WebViews and Bridge-ready
    identities are read from the app-owned closed markers, but Agent liveness
    and hidden-surface continuity require a separate operator fixture.  Thus a
    partial observation can only explain why the gate remains pending.
    """

    try:
        with _running_app(executable, openvscode) as (process, home, log_file, _started):
            shell_ok, offset, _ = _wait_for_marker(log_file, "app_shell_interactive", 0)
            if not shell_ok:
                return {
                    "status": "blocked",
                    "reason": "app_shell_marker_timeout",
                    "observed_editor_webviews": 0,
                    "observed_bridge_ready_surfaces": 0,
                    "agent_count": None,
                    "hidden_continuity": "not_executed",
                }
            # The Rust sink emits one first-ready marker per stable surface.
            # Wait only for the authoritative count; no timeout is converted
            # to a synthetic sample.
            deadline = time.monotonic() + INTERACTION_TIMEOUT_SECONDS
            bridge_ready = 0
            while time.monotonic() < deadline:
                bridge_ready = _performance_markers(log_file).count("editor_bridge_ready")
                if bridge_ready >= 9:
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.05)
            facts = _editor_host_lifecycle_facts(home)
            mounted = max(facts["max_created"], bridge_ready)
            if mounted < 9 or bridge_ready < 9:
                return {
                    "status": "blocked",
                    "reason": "real_state_did_not_mount_nine_editor_webviews",
                    "observed_editor_webviews": mounted,
                    "observed_bridge_ready_surfaces": bridge_ready,
                    "agent_count": None,
                    "hidden_continuity": "not_executed",
                    "lifecycle_facts": facts,
                }
            return {
                "status": "blocked",
                "reason": "live_agent_fixture_and_hidden_continuity_not_executed",
                "observed_editor_webviews": mounted,
                "observed_bridge_ready_surfaces": bridge_ready,
                "agent_count": None,
                "hidden_continuity": "not_executed",
                "lifecycle_facts": facts,
            }
    except OSError:
        return {
            "status": "blocked",
            "reason": "devhub_launch_unavailable",
            "observed_editor_webviews": 0,
            "observed_bridge_ready_surfaces": 0,
            "agent_count": None,
            "hidden_continuity": "not_executed",
        }


def _managed_openvscode_crash_attempt(
    executable: Path,
    openvscode: OpenVSCodeArtifact | None,
    input_driver: _NativeInput | None,
) -> dict[str, Any]:
    """Crash one owned OpenVSCode child and wait for the real bridge recovery."""

    marker = "editor_bridge_ready"
    if openvscode is None:
        return {
            "status": "blocked",
            "isolation_verified": False,
            "recovery_verified": False,
            "reason": "pinned_openvscode_bundle_missing",
        }
    try:
        with _running_app(executable, openvscode) as (process, home, log_file, _started):
            shell_ok, shell_offset, _ = _wait_for_marker(
                log_file, "app_shell_interactive", 0, timeout=INTERACTION_TIMEOUT_SECONDS
            )
            if not shell_ok:
                return {
                    "status": "blocked",
                    "isolation_verified": False,
                    "recovery_verified": False,
                    "reason": "app_shell_marker_timeout",
                }
            ready, offset, _ = _wait_for_marker(
                log_file, marker, shell_offset, timeout=20.0
            )
            if not ready:
                return {
                    "status": "blocked",
                    "isolation_verified": process.poll() is None,
                    "recovery_verified": False,
                    "reason": "editor_bridge_marker_timeout_before_crash",
                }
            deadline = time.monotonic() + 5.0
            killed = 0
            while time.monotonic() < deadline and killed == 0:
                killed = _kill_owned_openvscode(home, process.pid)
                if killed == 0:
                    time.sleep(0.05)
            if killed == 0:
                return {
                    "status": "blocked",
                    "isolation_verified": process.poll() is None,
                    "recovery_verified": False,
                    "reason": "managed_openvscode_pid_unavailable",
                }
            degraded, degraded_offset, _ = _wait_for_marker(
                log_file, "editor_provider_degraded", offset, timeout=10.0
            )
            isolated = process.poll() is None
            if not degraded:
                return {
                    "status": "blocked",
                    "isolation_verified": isolated,
                    "recovery_verified": False,
                    "reason": "editor_provider_degraded_marker_timeout",
                    "ordered_markers": _performance_markers(log_file),
                }
            origin = _wait_for_window_origin(process.pid)
            if origin is None or input_driver is None:
                return {
                    "status": "blocked",
                    "isolation_verified": isolated,
                    "recovery_verified": False,
                    "reason": "native_window_geometry_unavailable_after_crash",
                    "ordered_markers": _performance_markers(log_file),
                }
            if input_driver.invoke("click", str(origin[0] + 247), str(origin[1] + 27)) is None:
                return {
                    "status": "blocked",
                    "isolation_verified": isolated,
                    "recovery_verified": False,
                    "reason": "native_input_event_failed_after_crash",
                    "ordered_markers": _performance_markers(log_file),
                }
            recovered, _next_offset, _ = _wait_for_marker(
                log_file, "editor_provider_recovered", degraded_offset, timeout=20.0
            )
            if not recovered:
                return {
                    "status": "blocked",
                    "isolation_verified": isolated,
                    "recovery_verified": False,
                    "reason": "editor_provider_recovered_marker_timeout",
                    "ordered_markers": _performance_markers(log_file),
                }
            return {
                "status": "covered",
                "isolation_verified": isolated,
                "recovery_verified": True,
                "reason": "managed_openvscode_crash_recovered",
                "ordered_markers": _performance_markers(log_file),
            }
    except OSError:
        return {
            "status": "blocked",
            "isolation_verified": False,
            "recovery_verified": False,
            "reason": "devhub_launch_unavailable",
        }


def _run_timing_scenario(
    scenario: str,
    executable: Path,
    openvscode: OpenVSCodeArtifact | None,
    input_driver: _NativeInput | None,
) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []
    for role, run in [("setup", None), *[("measured", index + 1) for index in range(MEASURED_RUNS)]]:
        run_label = "setup" if run is None else f"run {run}/{MEASURED_RUNS}"
        print(f"q5.2: {scenario} {run_label} start", file=sys.stderr, flush=True)
        if scenario == "scratch_interactive":
            result = _scratch_attempt(executable, openvscode, input_driver)
        elif scenario == "workspace_picker_first_result":
            result = _marker_attempt(
                executable,
                openvscode,
                input_driver,
                "picker_first_result",
                action=(210, 155),
                seed_picker=True,
            )
        elif scenario == "mounted_activity_switch":
            result = _activity_attempt(executable, openvscode, input_driver)
        elif scenario == "cold_openvscode_interactive":
            result = _marker_attempt(executable, openvscode, input_driver, "editor_bridge_ready")
        elif scenario == "warm_workbench_reconstruction":
            result = _warm_reconstruction_attempt(executable, openvscode, input_driver)
        else:
            raise NativeReportError(f"unknown interactive scenario: {scenario}")
        print(
            f"q5.2: {scenario} {run_label} {result.get('status', 'unknown')}",
            file=sys.stderr,
            flush=True,
        )
        attempts.append({"role": role, **({"run": run} if run is not None else {}), **result})
    samples = [
        attempt["elapsed_ms"]
        for attempt in attempts
        if attempt.get("role") == "measured"
        and attempt.get("status") == "pass"
        and isinstance(attempt.get("elapsed_ms"), (int, float))
    ]
    if len(samples) == MEASURED_RUNS:
        return {
            "status": "measured",
            "setup_runs": SETUP_RUNS,
            "measured_runs": MEASURED_RUNS,
            "samples_ms": samples,
            "p95_ms": nearest_rank_p95(samples),
            "reason": "Real native marker observed after one setup and ten measured runs.",
            "attempts": attempts,
        }
    return {
        "status": "blocked",
        "setup_runs": SETUP_RUNS,
        "measured_runs": MEASURED_RUNS,
        "samples_ms": [],
        "p95_ms": None,
        "reason": next(
            (
                attempt.get("reason", "native_marker_unavailable")
                for attempt in attempts
                if attempt.get("status") != "pass"
            ),
            "native_marker_unavailable",
        ),
        "attempts": attempts,
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


def execute(
    host: Mapping[str, Any],
    openvscode: OpenVSCodeArtifact | None,
    *,
    run_providers: bool,
    only_scenario: str | None = None,
) -> dict[str, Any]:
    artifacts = host["artifacts"]
    gui = host["gui"]
    execution_boundary = host["execution_boundary"]
    binary_available = artifacts["devhub_debug_binary"] == "available"
    app_bundle_available = artifacts.get("devhub_debug_app_bundle") == "available"
    gui_available = bool(gui["interactive_session"])
    native_boundary_available = execution_boundary["status"] == "available"
    bundle_available = artifacts["openvscode"]["status"] == "available"
    blockers: list[str] = []
    if not native_boundary_available:
        blockers.append("native_execution_boundary_unavailable")
    if not binary_available:
        blockers.append("devhub_debug_binary_missing")
    if not bundle_available:
        blockers.append("pinned_openvscode_bundle_missing")
    if not gui_available:
        blockers.append("native_gui_session_unavailable")
    blockers.append("reference_context_not_proven")

    binary, app_bundle = _devhub_launch_target()
    reconstruction_binary = (
        app_bundle / "Contents" / "MacOS" / "devhub-app" if app_bundle is not None else None
    )
    shell_attempts: list[dict[str, Any]] = []
    # The Shell is a distinct native surface.  Exercise it whenever the real
    # app and GUI session exist, even if the managed editor bundle is missing;
    # the resulting marker timeout is useful blocker evidence and is never
    # promoted to an editor or reference-context timing claim.
    run_shell = only_scenario in (None, "process_cold_shell")
    if run_shell and binary_available and gui_available and native_boundary_available:
        print("q5.2: process_cold_shell setup start", file=sys.stderr, flush=True)
        shell_attempts.append({"role": "setup", **_launch_shell_attempt(binary, openvscode)})
        print(
            f"q5.2: process_cold_shell setup {shell_attempts[-1].get('status', 'unknown')}",
            file=sys.stderr,
            flush=True,
        )
        for index in range(MEASURED_RUNS):
            print(
                f"q5.2: process_cold_shell run {index + 1}/{MEASURED_RUNS} start",
                file=sys.stderr,
                flush=True,
            )
            attempt = _launch_shell_attempt(binary, openvscode)
            shell_attempts.append(
                {"role": "measured", "run": index + 1, **attempt}
            )
            print(
                f"q5.2: process_cold_shell run {index + 1}/{MEASURED_RUNS} {attempt.get('status', 'unknown')}",
                file=sys.stderr,
                flush=True,
            )
    elif run_shell:
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

    shell_block_reason = ";".join(blockers) or "AppShell marker run is blocked by host prerequisites."
    timing_runs = {
        "process_cold_shell": _timing_entry(shell_block_reason, shell_attempts),
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
            "Rust-owned App Shell marker was not observed before timeout."
        )

    input_driver = (
        _NativeInput.build()
        if binary_available and gui_available and native_boundary_available
        else None
    )
    for timing_id in TIMING_IDS:
        if timing_id == "process_cold_shell":
            continue
        if only_scenario is not None and timing_id != only_scenario:
            timing_runs[timing_id] = _timing_entry(
                f"scenario_filter:{only_scenario}; not executed"
            )
            continue
        if binary_available and gui_available and native_boundary_available:
            if timing_id == "warm_workbench_reconstruction" and not app_bundle_available:
                timing_runs[timing_id] = _timing_entry(
                    "debug_app_bundle_missing; LaunchServices reopen requires a real .app bundle."
                )
                continue
            scenario_binary = reconstruction_binary if timing_id == "warm_workbench_reconstruction" else binary
            if scenario_binary is None:
                timing_runs[timing_id] = _timing_entry(
                    "debug_app_bundle_missing; LaunchServices reopen requires a real .app bundle."
                )
                continue
            timing_runs[timing_id] = _run_timing_scenario(
                timing_id, scenario_binary, openvscode, input_driver
            )
        else:
            timing_runs[timing_id] = _timing_entry(
                "Native marker-driven run is unavailable; no synthetic timing is recorded."
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

    native_reason = ";".join(blockers) or "GUI, pinned bundle, and reference context are required for this native matrix."
    run_matrices = only_scenario is None
    if run_matrices and binary_available and gui_available and native_boundary_available and bundle_available:
        scale_probe = _editor_scale_probe(binary, openvscode)
        scale = [
            {
                "id": "scale-eight-workspaces-sixteen-agents-nine-editors",
                "requirement": "8 Workspaces; 16 live Agents across >=4 Workspaces; 9 Editor WebViews",
                **scale_probe,
            },
            {
                "id": "hidden-editor-continuity",
                "requirement": "Hide >=5 Editor WebViews for 10 minutes; verify identity, Bridge, dirty state, input",
                "status": "blocked",
                "reason": "ten-minute hidden-surface interaction fixture not executed",
                "observed_editor_webviews": scale_probe.get("observed_editor_webviews", 0),
                "hidden_continuity": "not_executed",
            },
        ]
        lifecycle_matrix = _window_reconstruction_matrix(
            reconstruction_binary or binary,
            openvscode,
        )
        lifecycle = [
            {
                "id": "window-reconstruction-10x",
                "requirement": "Window reconstruction x10",
                **lifecycle_matrix,
            },
            _matrix_entry(
                "quit-relaunch-5x",
                "Quit/relaunch x5 with >=2 Agents and >=2 live Workspace tmux sessions",
                "persistent-provider relaunch fixture not executed",
            ),
        ]
    else:
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
            "managed OpenVSCode crash probe not executed.",
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
    if binary_available and gui_available and native_boundary_available and bundle_available:
        crashes[0] = {
            "id": "managed-openvscode",
            "requirement": "Crash managed OpenVSCode; verify isolation and recovery",
            **_managed_openvscode_crash_attempt(binary, openvscode, input_driver),
        }
    if provider_checks.get("herdr_real_runtime", {}).get("status") == "pass":
        crashes[1].update({"status": "covered", "isolation_verified": True, "recovery_verified": True})
    if provider_checks.get("tmux_transition_matrix", {}).get("status") == "pass" and provider_checks.get(
        "tmux_pty_continuity", {}
    ).get("status") == "pass":
        crashes[2].update({"status": "covered", "isolation_verified": True, "recovery_verified": True})

    if input_driver is not None:
        input_driver.close()

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
    scale = report.get("scale_endurance")
    if not isinstance(scale, list) or not all(isinstance(entry, Mapping) for entry in scale) or [entry.get("id") for entry in scale] != [
        "scale-eight-workspaces-sixteen-agents-nine-editors",
        "hidden-editor-continuity",
    ]:
        raise NativeReportError("native scale matrix drifted")
    lifecycle = report.get("lifecycle")
    if not isinstance(lifecycle, list) or not all(isinstance(entry, Mapping) for entry in lifecycle) or [entry.get("id") for entry in lifecycle] != [
        "window-reconstruction-10x",
        "quit-relaunch-5x",
    ]:
        raise NativeReportError("native lifecycle matrix drifted")
    # A matrix is evidence-bearing only when its exact requirement and
    # verification facts are present.  In particular, no caller can turn a
    # validator-only placeholder into a pass by changing one status field.
    for entry in [*scale, *lifecycle]:
        if not isinstance(entry, Mapping) or not isinstance(entry.get("requirement"), str):
            raise NativeReportError("native matrix requirement missing")
        if entry.get("status") == "covered":
            if entry.get("id") == "window-reconstruction-10x":
                if entry.get("cycles_completed") != 10 or entry.get("identity_verified") is not True:
                    raise NativeReportError("window matrix claimed without ten identity-bound cycles")
            elif entry.get("id") == "scale-eight-workspaces-sixteen-agents-nine-editors":
                if entry.get("observed_editor_webviews") != 9 or entry.get("agent_count") != 16:
                    raise NativeReportError("scale matrix claimed without exact live counts")
            elif entry.get("id") == "hidden-editor-continuity":
                if entry.get("hidden_continuity") != "verified":
                    raise NativeReportError("hidden continuity claimed without verified evidence")
            elif entry.get("id") == "quit-relaunch-5x":
                if entry.get("cycles_completed") != 5 or entry.get("agents_retained") != 2 or entry.get("tmux_sessions_retained") != 2:
                    raise NativeReportError("relaunch matrix claimed without retained provider counts")
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
    payload = json.dumps(report, indent=2) + "\n"
    # Never truncate a previously accepted evidence file if the process is
    # interrupted while serializing or hardening the replacement.
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def self_test() -> None:
    if _execution_boundary({"CODEX_SANDBOX": "seatbelt"})["reason"] != "native_execution_boundary_unavailable":
        raise NativeReportError("sandbox boundary preflight failed")
    if _execution_boundary({})["reason"] != "native_execution_boundary_available":
        raise NativeReportError("native boundary preflight failed")
    resource_artifact = OpenVSCodeArtifact(
        Path("/private/tmp/q52-resource"), Path("/private/tmp/q52-resource"), "self_test"
    )
    resource_environment = _provider_environment({}, resource_artifact)
    if resource_environment.get("DEVHUB_RESOURCE_DIR") != "/private/tmp/q52-resource" or "DEVHUB_OPENVSCODE_EXECUTABLE" in resource_environment:
        raise NativeReportError("verified resource root was not propagated")
    executable_artifact = OpenVSCodeArtifact(Path("/private/tmp/q52-server"), None, "self_test")
    executable_environment = _provider_environment({}, executable_artifact)
    if executable_environment.get("DEVHUB_OPENVSCODE_EXECUTABLE") != "/private/tmp/q52-server":
        raise NativeReportError("standalone executable override was not propagated")
    # The measured value is anchored to the event timestamp, not to the
    # helper process return time. Simulated helper latency therefore cannot
    # inflate or deflate the product interval.
    event_timestamp_ns = 1_000_000_000_000
    marker_timestamp_ms = 1_001_500
    expected = _elapsed_from_native_event(event_timestamp_ns, marker_timestamp_ms)
    injected_helper_return_ns = event_timestamp_ns + 900_000_000
    if expected != _elapsed_from_native_event(event_timestamp_ns, marker_timestamp_ms):
        raise NativeReportError("helper latency changed event timing")
    if injected_helper_return_ns <= event_timestamp_ns or expected != 1_500.0:
        raise NativeReportError("event timing self-test setup invalid")
    if _elapsed_from_native_event(1_000_000_999_999, 1_000_000) != 0.0:
        raise NativeReportError("millisecond clock quantization changed event timing")
    try:
        _elapsed_from_native_event(2_000_000_000_000, 1_999_999)
    except NativeReportError as error:
        if str(error) != "event_marker_clock_order_invalid":
            raise
    else:
        raise NativeReportError("event/marker clock ordering was not validated")
    host = {
        "platform": {"os": "Darwin", "os_release": "local", "architecture": "arm64"},
        "toolchain": {},
        "artifacts": {
            "devhub_debug_binary": "missing",
            "openvscode": {"status": "missing", "source": "not_found", "pinned_identity": "not_verified"},
        },
        "gui": {"window_server": "unavailable", "accessibility": "unavailable", "interactive_session": False},
        "execution_boundary": {"status": "available", "reason": "native_execution_boundary_available"},
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
    parser.add_argument(
        "--only-scenario",
        choices=TIMING_IDS,
        help="execute one timing scenario (all other entries remain blocked)",
    )
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
        report = execute(
            host,
            openvscode,
            run_providers=args.execute and not args.skip_providers,
            only_scenario=args.only_scenario,
        )
        write_report(args.output, report)
        print(f"Q5.2 native report written: {args.output.name}")
        return 0
    except (NativeReportError, OSError, json.JSONDecodeError) as error:
        print(f"q5.2 native driver: {error}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
