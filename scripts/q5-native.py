#!/usr/bin/env python3
"""Run the real-process portion of the DevHub Q5.2 acceptance protocol.

The driver is deliberately conservative.  It discovers the built DevHub
binary and the separately installed official VS Code CLI, checks whether this
process has a WindowServer/Accessibility session and whether it is running
inside the Codex sandbox boundary, and writes a bounded redacted report.  If
those prerequisites and an explicit local server-license consent are
available, ``--execute`` launches the real DevHub binary once for setup and
ten measured cold-shell attempts.  The app emits the readiness marker from
the Rust diagnostics seam after the App Shell has committed its ready DOM.
Missing markers never become timing samples.  A sandboxed invocation records
``native_execution_boundary_unavailable`` and does not launch a GUI process,
so an execution-boundary restriction cannot be misreported as a product
marker timeout.

On a native macOS boundary the process-only scale/endurance path seeds isolated
real git workspaces, starts the real providers, and observes Rust-owned process,
Bridge, identity, dirty-state, lifecycle, and cleanup facts. It never compiles
or invokes the native input actor. User-attended screen/input scenarios are
available only through the explicit ``--interactive-manual`` option and remain
a final independent acceptance phase after MVP implementation, noninteractive
verification, commits, and the completion audit. ``--execute`` also runs the
real Herdr and tmux provider checks, preserving their exit status without
retaining their output.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import datetime as datetime_module
import json
import math
import os
import platform
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import termios
import threading
import time
import select
from dataclasses import dataclass, replace
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
OFFICIAL_VSCODE_CLI_ENV = "DEVHUB_VSCODE_CLI"
OFFICIAL_VSCODE_LICENSE_ENV = "DEVHUB_VSCODE_SERVER_LICENSE_ACCEPTED"
APP_RESOURCE_ENV = "DEVHUB_APP_RESOURCE_DIR"
OPENVSCODE_RESOURCE_ENV = "DEVHUB_OPENVSCODE_RESOURCE_DIR"
HERDR_SESSION_NAME = "devhub-session"
ROOT = Path(__file__).resolve().parents[1]
INPUT_HELPER_SOURCE = ROOT / "scripts" / "q5-native-input.swift"
RAW_PREFLIGHT_SOURCE = ROOT / "scripts" / "q5-herdr-raw-preflight.py"
REAL_HERDR_CHECK_SOURCE = ROOT / "scripts" / "check-agent-runtime-real.sh"
Q5_INPUT_FILE_NAME = "q5-input.txt"
Q5_INPUT_FILE_KEY_CODES = (12, 23, 27, 34, 45, 35, 32, 17, 47, 17, 7, 17)
Q5_PROVIDER_ERROR_CATEGORIES = frozenset(
    {
        "agent_name_taken",
        "agent_pane_busy",
        "agent_pane_not_found",
        "agent_pane_unavailable",
        "agent_start_input_failed",
        "invalid_request",
        "other",
    }
)
Q5_QUIT_OUTCOMES = frozenset(
    {
        "app_not_registered",
        "executable_unavailable",
        "executable_mismatch",
        "not_finished_launching",
        "already_terminated",
        "request_rejected",
        "sent",
    }
)
QuitOutcome = Literal[
    "app_not_registered",
    "executable_unavailable",
    "executable_mismatch",
    "not_finished_launching",
    "already_terminated",
    "request_rejected",
    "sent",
]
Q5_RECONSTRUCTION_STAGES = frozenset(
    {
        "capture_lifecycle",
        "app_shell_window",
        "window_identity",
        "restore_frame",
        "detach_host",
        "attach_host",
        "window_metrics",
        "snapshot",
        "global_surface",
        "workspace_surface",
        "hide_surfaces",
        "active_surface",
    }
)
Q5_RECONSTRUCTION_ERROR_CODES = frozenset(
    {
        "native_unavailable",
        "invalid_surface",
        "invalid_workspace_root",
        "invalid_port",
        "port_conflict",
        "permission_denied",
        "token_unavailable",
        "executable_unavailable",
        "executable_identity_mismatch",
        "official_vscode_unavailable",
        "provider_capability_mismatch",
        "license_consent_required",
        "bridge_unavailable",
        "bridge_install_failed",
        "process_unavailable",
        "process_identity_mismatch",
        "process_exited",
        "readiness_timeout",
        "webview_unavailable",
        "navigation_denied",
        "lifecycle_conflict",
        "io",
    }
)
def _q5_input_helper_contract() -> bool:
    """Keep the native filename and its tested keycode sequence in lockstep."""

    try:
        source = INPUT_HELPER_SOURCE.read_text(encoding="utf-8")
    except OSError:
        return False
    if f'let q5FileName = "{Q5_INPUT_FILE_NAME}"' not in source:
        return False
    marker = "let q5FileNameKeyCodes: [CGKeyCode] = ["
    if marker not in source:
        return False
    block = source.split(marker, 1)[1].split("]", 1)[0]
    try:
        codes = tuple(int(value) for value in re.findall(r"CGKeyCode\((\d+)\)", block))
    except ValueError:
        return False
    return (
        codes == Q5_INPUT_FILE_KEY_CODES
        and 'case "type-edit-character":' in source
        and ".activateAllWindows" in source
        and "kAXFrontmostAttribute" in source
        and "kAXMainAttribute" in source
        and "kAXFocusedAttribute" in source
        and "kAXFocusedWindowAttribute" in source
        and "kAXRaiseAction" in source
        and "frontmostApplication" in source
        and "func hasExactlyOneOnScreenLayerZeroWindow(for pid: pid_t) -> Bool" in source
        and "func exactDevHubWindow(for pid: pid_t, application: AXUIElement) -> AXUIElement?" in source
        and "CGWindowListCopyWindowInfo" in source
        and "kCGWindowOwnerPID" in source
        and "kCGWindowLayer" in source
        and "[.optionOnScreenOnly, .excludeDesktopElements]" in source
        and "let matches = windows.filter { axString($0, kAXTitleAttribute as CFString) == \"DevHub\" }" in source
        and "exactVisibleDevHubWindow" not in source
    )


def _q5_process_quit_helper_contract() -> bool:
    """Keep process-only Quit free of Accessibility and screen automation."""

    try:
        source = (ROOT / "scripts" / "q5-native-quit.swift").read_text(
            encoding="utf-8"
        )
    except OSError:
        return False
    return (
        all(f'"{outcome}"' in source for outcome in Q5_QUIT_OUTCOMES)
        and "NSRunningApplication(processIdentifier: expectedPID)" in source
        and "running.isTerminated" in source
        and "running.executableURL" in source
        and "actualURL.standardizedFileURL == executableURL" in source
        and "running.isFinishedLaunching" in source
        and "running.terminate()" in source
        and "let turnSeconds: TimeInterval = 0.05" in source
        and "let timeoutSeconds: TimeInterval = 3.0" in source
        and "RunLoop.main.run(until:" in source
        and "Date() < deadline" in source
        and "System Events" not in source
        and "AXUIElement" not in source
        and ".click" not in source
        and "print(expectedPID)" not in source
    )


def _self_test_native_quit_contract() -> None:
    """Exercise the closed Cocoa contract at an injected observation seam.

    The real helper supplies these observations from AppKit. Keeping the
    deterministic cases here lets the report driver test the retry/identity
    policy without launching a second GUI process or retaining any identity
    details in the report.
    """

    def simulate(observations: Sequence[Mapping[str, Any]]) -> tuple[NativeQuitResult, int]:
        saw_registration = False
        requests = 0
        last_transient: QuitOutcome | None = None
        for observation in observations[:60]:  # 60 * 50 ms is the 3 s bound.
            if not observation.get("registered"):
                continue
            saw_registration = True
            if observation.get("terminated"):
                return NativeQuitResult("already_terminated"), requests
            if observation.get("executable") is None:
                last_transient = "executable_unavailable"
                continue
            if observation.get("executable") != "/exact/devhub":
                return NativeQuitResult("executable_mismatch"), requests
            if not observation.get("finished_launching"):
                last_transient = "not_finished_launching"
                continue
            requests += 1
            if observation.get("terminate_result"):
                return NativeQuitResult("sent"), requests
        return NativeQuitResult(
            last_transient
            or ("request_rejected" if saw_registration else "app_not_registered")
        ), requests

    lagged, lagged_requests = simulate(
        (
            {"registered": False},
            {
                "registered": True,
                "terminated": False,
                "executable": "/exact/devhub",
                "finished_launching": True,
                "terminate_result": True,
            },
        )
    )
    if lagged.category != "sent" or lagged_requests != 1:
        raise NativeReportError("registration lag did not converge to sent")

    transient, transient_requests = simulate(
        (
            {
                "registered": True,
                "terminated": False,
                "executable": "/exact/devhub",
                "finished_launching": False,
            },
            {
                "registered": True,
                "terminated": False,
                "executable": "/exact/devhub",
                "finished_launching": True,
                "terminate_result": True,
            },
        )
    )
    if transient.category != "sent" or transient_requests != 1:
        raise NativeReportError("transient launch state did not converge to sent")

    retried, retried_requests = simulate(
        (
            {
                "registered": True,
                "terminated": False,
                "executable": "/exact/devhub",
                "finished_launching": True,
                "terminate_result": False,
            },
            {
                "registered": True,
                "terminated": False,
                "executable": "/exact/devhub",
                "finished_launching": True,
                "terminate_result": True,
            },
        )
    )
    if retried.category != "sent" or retried_requests != 2:
        raise NativeReportError("rejected Cocoa request was not retried")

    mismatch, mismatch_requests = simulate(
        (
            {
                "registered": True,
                "terminated": False,
                "executable": "/stale/devhub",
                "finished_launching": True,
                "terminate_result": True,
            },
        )
    )
    if mismatch.category != "executable_mismatch" or mismatch_requests != 0:
        raise NativeReportError("executable mismatch issued a termination request")

    rejected, rejected_requests = simulate(
        tuple(
            {
                "registered": True,
                "terminated": False,
                "executable": "/exact/devhub",
                "finished_launching": True,
                "terminate_result": False,
            }
            for _ in range(60)
        )
    )
    if rejected.category != "request_rejected" or rejected_requests != 60:
        raise NativeReportError("persistent Cocoa request rejection did not fail closed")


def _q5_raw_preflight_cleanup_contract() -> bool:
    """Prevent raw provider probes from orphaning daemonized Herdr servers."""

    try:
        source = RAW_PREFLIGHT_SOURCE.read_text(encoding="utf-8")
    except OSError:
        return False
    subscriptions_closed = source.find("for subscription in reversed(subscriptions):")
    owner_closed = source.find("owner.__exit__(None, None, None)")
    return (
        -1 < subscriptions_closed < owner_closed
        and 'q5._q5_owned_fixture_home("dh-q5-raw-")' in source
        and "fixture.stop_herdr_first = True" in source
        and "TemporaryDirectory" not in source
        and "tempfile.mkdtemp" not in source
        and "/private/tmp" not in source
    )


def _scale_home_source_is_secure(source: str, *, shell: bool = False) -> bool:
    """Reject insecure HOME allocators on every scale-reachable subprocess."""

    common_banned = ("/private/tmp", "ignore_cleanup_errors")
    if any(token in source for token in common_banned):
        return False
    if shell:
        return (
            "DEVHUB_Q5_SECURE_RUN_ROOT" in source
            and 'mktemp -d "$Q5_SECURE_PARENT/r.XXXXXX"' in source
            and "socket_path_too_long" in source
            and "$TMPDIR" not in source
            and "${TMPDIR}" not in source
            and "mktemp -d /tmp" not in source
            and not re.search(r"mktemp\s+-d(?:\s*$|\s+[\"']?/tmp)", source, re.MULTILINE)
        )
    return (
        "tempfile.TemporaryDirectory" not in source
        and "tempfile.mkdtemp" not in source
    )


def _q5_scale_subprocess_home_contract(driver_source: str) -> bool:
    try:
        raw_source = RAW_PREFLIGHT_SOURCE.read_text(encoding="utf-8")
        real_source = REAL_HERDR_CHECK_SOURCE.read_text(encoding="utf-8")
    except OSError:
        return False
    cold_source = driver_source.rsplit("def _launch_shell_attempt(", 1)[1].split(
        "def _marker_attempt", 1
    )[0]
    return (
        _scale_home_source_is_secure(raw_source)
        and "_q5_owned_fixture_home" in raw_source
        and _scale_home_source_is_secure(cold_source)
        and "with _running_app(" in cold_source
        and _scale_home_source_is_secure(real_source, shell=True)
        and "_secure_provider_check_status" in driver_source
    )


TIMING_IDS = (
    "process_cold_shell",
    "scratch_interactive",
    "workspace_picker_first_result",
    "mounted_activity_switch",
    "cold_openvscode_interactive",
    "warm_workbench_reconstruction",
)
TIMING_BUDGET_MS = {
    "process_cold_shell": 2_000.0,
    "scratch_interactive": 3_000.0,
    "workspace_picker_first_result": 300.0,
    "mounted_activity_switch": 100.0,
    "cold_openvscode_interactive": 10_000.0,
    "warm_workbench_reconstruction": 5_000.0,
}

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
        "q5_fixture_workspace_ready",
        "q5_fixture_workspace_failed",
        "q5_fixture_agent_ready",
        "q5_fixture_agent_failed",
        "q5_fixture_profiles_unavailable",
        "q5_fixture_agent_launch_failed",
        "q5_fixture_agent_dispatch_failed",
        "q5_fixture_agent_process_evidence_timeout",
        "q5_fixture_agent_final_reconcile_timeout",
        "q5_fixture_snapshot_failed",
        "q5_fixture_herdr_reconcile_failed",
        "q5_fixture_scale_deadline_exceeded",
        "q5_fixture_scale_setup_deadline",
        "q5_fixture_surface_warm_ready",
        "q5_fixture_surface_warm_timeout",
        "q5_fixture_surface_warm_dispatch_failed",
        "q5_fixture_surface_warm_wait_timeout",
        "q5_fixture_started",
        "q5_fixture_start_skipped",
        "q5_fixture_start_failed",
        "q5_fixture_scale_ready",
        "q5_hidden_prepare",
        "q5_hidden_hold_started",
        "q5_hidden_continuity_verified",
        "q5_quit_relaunch_ready",
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


@dataclass(frozen=True)
class NativeQuitResult:
    """One closed result from the Cocoa process-termination boundary."""

    category: QuitOutcome

    def __post_init__(self) -> None:
        if self.category not in Q5_QUIT_OUTCOMES:
            raise ValueError("unknown native quit outcome")

    @property
    def accepted(self) -> bool:
        """Return whether the caller may continue to the durable clean proof."""

        return self.category in {"sent", "already_terminated"}


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


def _command_status(
    command: Sequence[str],
    timeout: float = 120.0,
    *,
    environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Run a real provider check while retaining only bounded safe facts."""

    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            env=dict(environment) if environment is not None else None,
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
    resource_override = os.environ.get(OPENVSCODE_RESOURCE_ENV)
    if resource_override is None:
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


@dataclass(frozen=True)
class OfficialVSCodeArtifact:
    """A user-installed official VS Code CLI discovered in place.

    The driver retains only release identity and capability facts.  It never
    copies the application or bundles it into the DevHub launch environment.
    """

    executable: Path
    version: str
    commit: str
    architecture: str
    source: str
    license_accepted: bool = False

    def report(self) -> dict[str, Any]:
        return {
            "status": "available",
            "source": self.source,
            "version": self.version,
            "commit": self.commit,
            "architecture": self.architecture,
            "capabilities": "verified",
            "license_consent": "explicit" if self.license_accepted else "not_set",
        }


ProviderArtifact = OpenVSCodeArtifact | OfficialVSCodeArtifact


def _official_cli_candidates() -> list[tuple[str, Path]]:
    candidates: list[tuple[str, Path]] = []
    override = os.environ.get(OFFICIAL_VSCODE_CLI_ENV)
    if override:
        candidates.append(("environment_override", Path(override)))
    path = shutil.which("code")
    if path:
        candidates.append(("path", Path(path)))
    candidates.extend(
        (
            ("application", Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")),
            (
                "application_insiders",
                Path("/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"),
            ),
        )
    )
    return candidates


def _official_version(path: Path) -> tuple[str, str, str] | None:
    """Probe the official CLI's bounded release identity in place."""

    try:
        result = subprocess.run(
            [str(path), "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    fields = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if len(fields) < 3:
        return None
    version, commit, architecture = fields[:3]
    if (
        not version.count(".") == 2
        or not all(component.isdigit() for component in version.split("."))
        or len(commit) != 40
        or not all(character in "0123456789abcdefABCDEF" for character in commit)
        or not architecture
        or len(architecture) > 32
    ):
        return None
    return version, commit, architecture


def _official_capabilities(path: Path) -> bool:
    try:
        result = subprocess.run(
            [str(path), "serve-web", "--help"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    help_text = result.stdout or ""
    return result.returncode == 0 and all(
        flag in help_text
        for flag in (
            "--connection-token-file",
            "--server-data-dir",
            "--disable-telemetry",
            "--default-folder",
        )
    )


def discover_official_vscode() -> tuple[dict[str, Any], OfficialVSCodeArtifact | None]:
    seen: set[str] = set()
    for source, candidate in _official_cli_candidates():
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        key = str(resolved)
        if key in seen or not _regular_executable(resolved):
            continue
        seen.add(key)
        identity = _official_version(resolved)
        if identity is None or not _official_capabilities(resolved):
            continue
        version, commit, architecture = identity
        artifact = OfficialVSCodeArtifact(resolved, version, commit, architecture, source)
        return artifact.report(), artifact
    return {
        "status": "missing",
        "source": "not_found",
        "version": "unknown",
        "commit": "unknown",
        "architecture": "unknown",
        "capabilities": "not_verified",
    }, None


def _provider_environment(
    base: Mapping[str, str],
    artifact: ProviderArtifact | None,
    *,
    license_accepted: bool | None = None,
) -> dict[str, str]:
    """Propagate one verified provider boundary without copying artifacts."""

    environment = dict(base)
    if artifact is None:
        return environment
    # The Bridge package is an app-owned resource for every provider. The
    # legacy provider's executable resource is carried separately below.
    environment[APP_RESOURCE_ENV] = str(ROOT)
    environment.pop("DEVHUB_RESOURCE_DIR", None)
    if isinstance(artifact, OfficialVSCodeArtifact):
        if license_accepted is None:
            license_accepted = artifact.license_accepted
        environment["DEVHUB_EDITOR_PROVIDER"] = "official-vscode"
        environment[OFFICIAL_VSCODE_CLI_ENV] = str(artifact.executable)
        environment.pop(OPENVSCODE_RESOURCE_ENV, None)
        environment.pop("DEVHUB_OPENVSCODE_EXECUTABLE", None)
        if license_accepted:
            environment[OFFICIAL_VSCODE_LICENSE_ENV] = "1"
        else:
            environment.pop(OFFICIAL_VSCODE_LICENSE_ENV, None)
    elif artifact.resource_root is not None:
        environment["DEVHUB_EDITOR_PROVIDER"] = "openvscode"
        environment[OPENVSCODE_RESOURCE_ENV] = str(artifact.resource_root)
        environment.pop("DEVHUB_OPENVSCODE_EXECUTABLE", None)
    else:
        environment["DEVHUB_EDITOR_PROVIDER"] = "openvscode"
        environment["DEVHUB_OPENVSCODE_EXECUTABLE"] = str(artifact.executable)
        environment.pop(OPENVSCODE_RESOURCE_ENV, None)
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


def probe_host() -> tuple[dict[str, Any], OfficialVSCodeArtifact | None, OpenVSCodeArtifact | None]:
    official_report, official_vscode = discover_official_vscode()
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
            "official_vscode": official_report,
            "openvscode": openvscode_report,
        },
        "gui": gui,
        "execution_boundary": _execution_boundary(),
        "reference_context": "not_proven",
        "reference_context_facts": _reference_context_facts(),
        "machine_identifiers": "omitted",
        "ambient_paths": "omitted",
    }
    return host, official_vscode, openvscode


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

    # Rust writes the same closed marker to two channels. The marker file is
    # the authoritative untimestamped sequence for Q5 fixture/count facts;
    # diagnostics is a fallback for runs where that dedicated channel was not
    # configured or could not be read. Merging the channels doubles every
    # Workspace, Agent, and Editor fact. Timestamped timing continues to use
    # `_marker_observed` and therefore remains diagnostics-owned.
    marker_path = log_file.parents[3] / ".q5-markers"
    try:
        marker_lines = marker_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        marker_lines = None
    if marker_lines is not None:
        return [
            marker
            for marker in marker_lines[-MAX_RETAINED_PERFORMANCE_MARKERS:]
            if marker in PERFORMANCE_MARKER_VOCABULARY
        ]

    try:
        lines = log_file.read_bytes().splitlines()[-MAX_RETAINED_PERFORMANCE_MARKERS:]
    except OSError:
        lines = []
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


def _performance_marker_count(log_file: Path, marker: str) -> int:
    """Count one closed marker without the bounded observation-window loss."""

    marker_path = log_file.parents[3] / ".q5-markers"
    try:
        with marker_path.open(encoding="utf-8") as stream:
            return sum(1 for line in stream if line.strip() == marker)
    except OSError:
        pass
    count = 0
    try:
        with log_file.open("rb") as stream:
            for raw_line in stream:
                try:
                    record = json.loads(raw_line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if record.get("event") == "performance" and record.get("marker") == marker:
                    count += 1
    except OSError:
        return 0
    return count


def _q5_counter_facts(home: Path, name: str) -> list[dict[str, int]]:
    """Read bounded Rust-owned Q5 counters without retaining identities."""

    try:
        lines = (home / ".q5-markers").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    facts: list[dict[str, int]] = []
    for line in lines:
        fields = dict(
            field.split("=", 1)
            for field in line.split()
            if "=" in field
        )
        if fields.get("fact") != name:
            continue
        try:
            fact = {"value": int(fields["value"])}
            if "index" in fields:
                fact["index"] = int(fields["index"])
            facts.append(fact)
        except (KeyError, ValueError):
            continue
    return facts


def _q5_dispatch_diagnostics(home: Path) -> list[dict[str, Any]]:
    """Read the single closed dispatch-failure fact emitted by the Q5 fixture."""

    try:
        lines = (home / ".q5-markers").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    diagnostics: list[dict[str, Any]] = []
    allowed = {
        "index",
        "stage",
        "effect",
        "app_error_code",
        "port_error_code",
        "agent_runtime_error_code",
        "provider_error_category",
        "workspace_count",
        "completed_agents",
    }
    for line in lines:
        fields = {
            key: value
            for key, value in (field.split("=", 1) for field in line.split() if "=" in field)
        }
        if fields.get("fact") != "q5_dispatch_failure":
            continue
        if not set(fields).issubset(allowed | {"fact"}):
            continue
        try:
            diagnostic: dict[str, Any] = {
                "index": int(fields["index"]),
                "workspace_count": int(fields["workspace_count"]),
                "completed_agents": int(fields["completed_agents"]),
                "stage": fields["stage"],
                "effect": fields["effect"],
                "app_error_code": fields["app_error_code"],
                "port_error_code": fields["port_error_code"],
                "agent_runtime_error_code": fields["agent_runtime_error_code"],
                "provider_error_category": fields["provider_error_category"],
            }
        except (KeyError, ValueError):
            continue
        if diagnostic["provider_error_category"] not in Q5_PROVIDER_ERROR_CATEGORIES:
            continue
        diagnostics.append(diagnostic)
    return diagnostics[-1:]


def _q5_reconstruction_diagnostics(home: Path) -> list[dict[str, str]]:
    """Read one content-free, closed reconstruction failure fact."""

    try:
        lines = (home / ".q5-markers").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    facts: list[dict[str, str]] = []
    for line in lines:
        fields = {
            key: value
            for key, value in (field.split("=", 1) for field in line.split() if "=" in field)
        }
        if fields.get("fact") != "q5_startup_reconstruction":
            continue
        if set(fields) != {"fact", "stage", "status", "error_code"}:
            continue
        if (
            fields["stage"] not in Q5_RECONSTRUCTION_STAGES
            or fields["status"] != "failed"
            or fields["error_code"] not in Q5_RECONSTRUCTION_ERROR_CODES
        ):
            continue
        facts.append(
            {
                "stage": fields["stage"],
                "status": fields["status"],
                "error_code": fields["error_code"],
            }
        )
    return facts[-1:]


def _q5_state_shape(home: Path) -> dict[str, Any]:
    """Return only persistence shape/count facts; never values, IDs, or paths."""

    path = home / "Library" / "Application Support" / "DevHub" / "state.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "status": "unavailable",
            "schema_version": None,
            "workspace_count": 0,
            "agent_count": 0,
            "provider_mapping_count": 0,
            "shutdown_clean": None,
        }
    if not isinstance(state, Mapping):
        return {
            "status": "invalid_shape",
            "schema_version": None,
            "workspace_count": 0,
            "agent_count": 0,
            "provider_mapping_count": 0,
            "shutdown_clean": None,
        }
    workspaces = state.get("workspaces")
    if not isinstance(workspaces, list):
        workspaces = []
    agent_count = 0
    provider_mapping_count = 0
    for workspace in workspaces:
        if not isinstance(workspace, Mapping):
            continue
        agents = workspace.get("agents")
        if not isinstance(agents, list):
            continue
        for agent in agents:
            if not isinstance(agent, Mapping):
                continue
            agent_count += 1
            if agent.get("provider_mapping") is not None:
                provider_mapping_count += 1
    schema_version = state.get("schema_version")
    shutdown = state.get("shutdown")
    shutdown_clean = (
        shutdown.get("clean")
        if isinstance(shutdown, Mapping) and isinstance(shutdown.get("clean"), bool)
        else None
    )
    return {
        "status": "present",
        "schema_version": schema_version if isinstance(schema_version, int) else None,
        "workspace_count": len(workspaces),
        "agent_count": agent_count,
        "provider_mapping_count": provider_mapping_count,
        "shutdown_clean": shutdown_clean,
    }


def _q5_editor_port_file(
    home: Path, provider: ProviderArtifact | None = None
) -> tuple[str, Path | None]:
    root = home / "Library" / "Application Support" / "DevHub"
    if isinstance(provider, OfficialVSCodeArtifact):
        kind = "official"
        candidate = root / "VisualStudioCode" / "port"
        return (kind, candidate if candidate.is_file() else None)
    if isinstance(provider, OpenVSCodeArtifact):
        kind = "legacy"
        candidate = root / "OpenVSCode" / "port"
        return (kind, candidate if candidate.is_file() else None)
    candidates = (
        ("official", root / "VisualStudioCode" / "port"),
        ("legacy", root / "OpenVSCode" / "port"),
    )
    return next(
        ((kind, candidate) for kind, candidate in candidates if candidate.is_file()),
        ("missing", None),
    )


def _q5_editor_port_probe(
    home: Path,
    provider: ProviderArtifact | None = None,
    owned_provider_pids: Sequence[int] = (),
) -> dict[str, Any]:
    """Return one closed stable-origin observation without retaining its port."""

    kind, port_file = _q5_editor_port_file(home, provider)
    if port_file is None:
        return {
            "available": None,
            "selected_provider_port_file": "missing",
            "listener_count": 0,
            "listener_owned_by_fixture": False,
        }
    port: int | None = None
    try:
        value = port_file.read_text(encoding="utf-8").strip()
        port = int(value)
        if port < 1024 or port > 65535:
            raise ValueError
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            # Match the product PortAllocator: reusable TIME_WAIT is not an
            # active stable-origin conflict, while an active listener still
            # rejects this bind. SO_REUSEPORT is intentionally absent.
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", port))
        return {
            "available": True,
            "selected_provider_port_file": kind,
            "listener_count": 0,
            "listener_owned_by_fixture": False,
        }
    except (OSError, ValueError):
        listener_pids: set[int] = set()
        lsof = shutil.which("lsof") or "/usr/sbin/lsof"
        if port is not None and 1024 <= port <= 65535:
            try:
                result = subprocess.run(
                    [lsof, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    text=True,
                    timeout=1,
                )
                listener_pids = {
                    int(line) for line in result.stdout.splitlines() if line.strip().isdigit()
                }
            except (OSError, subprocess.SubprocessError):
                pass
        return {
            "available": False,
            "selected_provider_port_file": kind,
            "listener_count": len(listener_pids),
            "listener_owned_by_fixture": bool(
                listener_pids.intersection(owned_provider_pids)
            ),
        }


def _q5_editor_port_available(
    home: Path, provider: ProviderArtifact | None = None
) -> bool | None:
    """Probe only stable-origin availability; never return or retain the port."""

    return _q5_editor_port_probe(home, provider).get("available")


def _q5_wait_editor_port_release(
    home: Path,
    provider: ProviderArtifact | None,
    owned_provider_pids: Sequence[int],
    *,
    budget_seconds: float = 2.0,
) -> dict[str, Any]:
    """Require a quiescent stable origin after exact process termination."""

    deadline = time.monotonic() + budget_seconds
    consecutive_available = 0
    observation = _q5_editor_port_probe(home, provider, owned_provider_pids)
    while True:
        if observation["available"] is True:
            consecutive_available += 1
            if consecutive_available >= 2:
                return {**observation, "category": "released"}
        else:
            consecutive_available = 0
        if time.monotonic() >= deadline:
            category = (
                "provider_port_file_missing"
                if observation["selected_provider_port_file"] == "missing"
                else "owned_listener_persisted"
                if observation["listener_owned_by_fixture"]
                else "listener_persisted"
                if observation["listener_count"] > 0
                else "port_not_released"
            )
            return {**observation, "category": category}
        time.sleep(0.025)
        observation = _q5_editor_port_probe(home, provider, owned_provider_pids)


def _q5_fixture_terminal_failure(markers: Sequence[str]) -> str | None:
    """Map owner-side terminal fixture markers to one stable report reason.

    A terminal failure must end the waiter immediately. In particular, a
    rejected Agent dispatch is not a setup delay and must never consume the
    remaining scale-fixture deadline.
    """

    if "q5_fixture_agent_dispatch_failed" in markers:
        return "q5_fixture_agent_dispatch_failed"
    if "q5_fixture_start_failed" in markers:
        return "startup_reconstruction_failed"
    if "q5_fixture_start_skipped" in markers:
        return "startup_reconstruction_not_ready"
    return None


def _q5_fixture_terminal_failure_after(
    markers: Sequence[str], counts_before_launch: Mapping[str, int]
) -> str | None:
    """Return only a terminal failure emitted by the current launch."""

    for marker, count_before_launch in counts_before_launch.items():
        if markers.count(marker) > count_before_launch:
            return _q5_fixture_terminal_failure((marker,))
    return None


def _q5_marker_advanced(markers: Sequence[str], marker: str, count_before_launch: int) -> bool:
    """Accept a lifecycle marker only when the current launch appended it."""

    return markers.count(marker) > count_before_launch


def _q5_hidden_continuity_fact(home: Path) -> dict[str, Any] | None:
    """Read the owner-side hidden continuity comparison as closed facts."""

    try:
        lines = (home / ".q5-markers").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    allowed = {
        "baseline_count",
        "current_count",
        "hidden_count",
        "duration_ms",
        "missing_count",
        "disconnected_count",
        "generation_mismatch_count",
        "context_mismatch_count",
        "dirty_mismatch_count",
        "owner_missing_count",
        "owner_lookup_result",
        "owner_lookup_error_code",
        "active_editor",
        "continuity",
    }
    for line in reversed(lines):
        fields = {
            key: value
            for key, value in (field.split("=", 1) for field in line.split() if "=" in field)
        }
        if fields.get("fact") != "q5_hidden_continuity":
            continue
        if not set(fields).issubset(allowed | {"fact"}):
            continue
        try:
            fact: dict[str, Any] = {
                "baseline_count": int(fields["baseline_count"]),
                "current_count": int(fields["current_count"]),
                "hidden_count": int(fields["hidden_count"]),
                "duration_ms": int(fields["duration_ms"]),
                "missing_count": int(fields["missing_count"]),
                "disconnected_count": int(fields["disconnected_count"]),
                "generation_mismatch_count": int(fields["generation_mismatch_count"]),
                "context_mismatch_count": int(fields["context_mismatch_count"]),
                "dirty_mismatch_count": int(fields["dirty_mismatch_count"]),
                "owner_missing_count": int(fields["owner_missing_count"]),
                "owner_lookup_result": fields["owner_lookup_result"],
                "owner_lookup_error_code": fields["owner_lookup_error_code"],
                "active_editor": fields["active_editor"],
                "continuity": fields["continuity"],
            }
        except (KeyError, ValueError):
            continue
        if any(fact[name] < 0 for name in (
            "baseline_count",
            "current_count",
            "hidden_count",
            "duration_ms",
            "missing_count",
            "disconnected_count",
            "generation_mismatch_count",
            "context_mismatch_count",
            "dirty_mismatch_count",
            "owner_missing_count",
        )):
            continue
        if fact["owner_lookup_result"] not in {"ok", "error"}:
            continue
        owner_error_codes = {
            "none",
            "lifecycle_changed",
            "bridge_observation_timeout",
            "hide_surfaces_failed",
            "hidden_surface_count_insufficient",
            "snapshot_unavailable",
            "surface_inventory_unavailable",
            "surface_inventory_mismatch",
        }
        if fact["owner_lookup_error_code"] not in owner_error_codes:
            continue
        if (fact["owner_lookup_result"] == "ok") != (
            fact["owner_lookup_error_code"] == "none"
        ):
            continue
        if fact["active_editor"] not in {"global", "workspace", "none"}:
            continue
        if fact["continuity"] not in {"pass", "fail"}:
            continue
        return fact
    return None


def _q5_hidden_observation_budget_seconds() -> float:
    """Bound the observer to the Rust short-repro hold when explicitly set."""

    if os.environ.get("DEVHUB_Q5_SHORT_REPRO") != "1":
        return 620.0
    try:
        seconds = int(os.environ.get("DEVHUB_Q5_HIDDEN_HOLD_SECONDS", "600"))
    except ValueError:
        seconds = 600
    if not 1 <= seconds <= 600:
        seconds = 600
    # Leave a bounded margin for the post-hold content-free comparison. The
    # formal path remains 600 seconds plus the existing 20-second margin.
    return float(seconds + 20)


def _q5_relaunch_state_facts(home: Path) -> list[dict[str, Any]]:
    """Read exact, content-free state/Bridge facts emitted once per launch."""

    try:
        lines = (home / ".q5-markers").read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    count_fields = (
        "workspace_count",
        "agent_count",
        "mapping_count",
        "surface_count",
        "missing_identity_count",
        "duplicate_identity_count",
        "disconnected_count",
        "not_ready_count",
        "generation_zero_count",
        "context_mismatch_count",
    )
    allowed = {*count_fields, "active_editor", "status"}
    facts: list[dict[str, Any]] = []
    for line in lines:
        fields = {
            key: value
            for key, value in (field.split("=", 1) for field in line.split() if "=" in field)
        }
        if fields.get("fact") != "q5_relaunch_state" or set(fields) != allowed | {"fact"}:
            continue
        try:
            fact = {name: int(fields[name]) for name in count_fields}
        except (KeyError, ValueError):
            continue
        if any(value < 0 for value in fact.values()):
            continue
        if fields["active_editor"] not in {"global", "workspace", "none"}:
            continue
        if fields["status"] not in {"pass", "fail"}:
            continue
        fact.update(active_editor=fields["active_editor"], status=fields["status"])
        facts.append(fact)
    return facts


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


def _seed_native_config(home: Path, deterministic_agent_path: Path | None = None) -> None:
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
    if deterministic_agent_path is None:
        payload = "version = 1\n\n[general]\nimport_login_environment = false\n"
    else:
        path = str(deterministic_agent_path)
        agent_path = f"{path}:/opt/homebrew/bin:/usr/bin:/bin"
        trace_path = home / ".q5-agent-trace"
        pid_dir = home / ".q5-pids"
        payload = f'''version = 1

[general]
import_login_environment = false

[[agent_profiles]]
id = "codex"
display_name = "Q5 deterministic Codex"
kind = "codex"
args = ["--q5-deterministic"]
[agent_profiles.env]
PATH = "{agent_path}"
HERDR_AGENT = "codex"
DEVHUB_HERDR_TRACE_FILE = "{trace_path}"
DEVHUB_HERDR_PID_DIR = "{pid_dir}"

[[agent_profiles]]
id = "claude"
display_name = "Q5 deterministic Claude"
kind = "claude"
args = ["--q5-deterministic"]
[agent_profiles.env]
PATH = "{agent_path}"
HERDR_AGENT = "claude"
DEVHUB_HERDR_TRACE_FILE = "{trace_path}"
DEVHUB_HERDR_PID_DIR = "{pid_dir}"
'''
    config.write_text(payload, encoding="utf-8")
    config.chmod(0o600)
    if deterministic_agent_path is not None:
        agent_path = f"{deterministic_agent_path}:/opt/homebrew/bin:/usr/bin:/bin"
        for name in (".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc"):
            startup = home / name
            startup.write_text(f'export PATH="{agent_path}"\n', encoding="utf-8")
            startup.chmod(0o600)
        herdr_config = home / ".config" / "herdr" / "config.toml"
        herdr_config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        herdr_config.write_text(
            "[update]\nversion_check = false\nmanifest_check = false\n",
            encoding="utf-8",
        )
        herdr_config.chmod(0o600)


def _prepare_q5_agent_commands(home: Path) -> Path:
    """Compile the proven basename-sensitive deterministic Herdr helper."""

    commands = home / "bin"
    commands.mkdir(mode=0o700, exist_ok=True)
    source = ROOT / "scripts" / "q5-deterministic-agent.c"
    compiler = shutil.which("clang") or shutil.which("cc")
    if compiler is None:
        raise OSError("clang_or_cc_unavailable")
    helper = commands / "deterministic-agent"
    subprocess.run(
        [compiler, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", str(helper), str(source)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=30,
    )
    helper.chmod(0o700)
    for name in ("codex", "claude"):
        command = commands / name
        shutil.copy2(helper, command)
        command.chmod(0o700)
    return commands


def _q5_fixture_preflight(home: Path, commands: Path) -> None:
    """Validate only the deterministic provider shape; retain no paths."""

    for name in ("codex", "claude"):
        executable = commands / name
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise OSError("q5_agent_executable_unavailable")
        if executable.name != name:
            raise OSError("q5_agent_basename_mismatch")
    expected_suffix = ":/opt/homebrew/bin:/usr/bin:/bin"
    for name in (".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc"):
        startup = home / name
        if expected_suffix not in startup.read_text(encoding="utf-8"):
            raise OSError("q5_shell_path_preflight_failed")
    herdr_config = home / ".config" / "herdr" / "config.toml"
    if "version_check = false" not in herdr_config.read_text(encoding="utf-8"):
        raise OSError("q5_herdr_config_preflight_failed")


def _q5_socket_path_preflight(home: Path) -> None:
    """Keep Herdr Unix sockets below macOS sockaddr_un's 104-byte bound."""

    session_root = _q5_herdr_socket(home).parent
    socket_paths = (_q5_herdr_socket(home), session_root / "herdr-client.sock")
    if any(len(os.fsencode(str(path))) >= 104 for path in socket_paths):
        raise OSError("q5_herdr_socket_path_too_long")


def _q5_herdr_socket(home: Path) -> Path:
    """Return the exact harness-owned named-session API socket."""

    return home / ".config" / "herdr" / "sessions" / HERDR_SESSION_NAME / "herdr.sock"


def _stop_owned_herdr(home: Path) -> bool:
    """Gracefully stop only the Herdr server for this isolated Q5 HOME.

    Herdr's server argv intentionally does not contain HOME, so process-name
    or argv matching cannot establish ownership. The named-session socket is
    the ownership boundary: send ``server.stop`` there, then require the
    exact socket to disappear within a bounded interval before generic child
    cleanup or temporary-HOME removal proceeds.
    """

    socket_path = _q5_herdr_socket(home)
    if not socket_path.exists():
        return True
    request = (
        json.dumps({"id": "devhub-q5-server-stop", "method": "server.stop", "params": {}})
        + "\n"
    ).encode()
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(3.0)
            client.connect(str(socket_path))
            client.sendall(request)
            response = bytearray()
            while not response.endswith(b"\n"):
                chunk = client.recv(4096)
                if not chunk:
                    return False
                response.extend(chunk)
                if len(response) > 64 * 1024:
                    return False
        decoded = json.loads(response)
    except (OSError, socket.timeout, json.JSONDecodeError):
        return False
    if not isinstance(decoded, Mapping) or "error" in decoded:
        return False

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if not socket_path.exists():
            return True
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.2)
                probe.connect(str(socket_path))
        except (FileNotFoundError, ConnectionRefusedError, NotADirectoryError, OSError):
            if not socket_path.exists():
                return True
        time.sleep(0.05)
    return False


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

    _RESPONSE_TIMEOUT_SECONDS = 2.0
    _ACTIVATE_RESPONSE_TIMEOUT_SECONDS = 3.0

    def __init__(self, executable: Path):
        self.executable = executable
        self._process: subprocess.Popen[str] | None = None
        self._invalidated = False

    @classmethod
    def build(cls) -> "_NativeInput | None":
        if platform.system() != "Darwin" or shutil.which("swiftc") is None:
            return None
        if not INPUT_HELPER_SOURCE.is_file() or not _q5_input_helper_contract():
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

    def _invalidate(self) -> None:
        """Poison the actor after an uncertain or malformed protocol exchange."""

        self._invalidated = True
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
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def invoke(self, *arguments: str) -> int | None:
        process = self._process
        if (
            self._invalidated
            or process is None
            or process.poll() is not None
            or process.stdin is None
            or process.stdout is None
        ):
            return None
        timeout = (
            self._ACTIVATE_RESPONSE_TIMEOUT_SECONDS
            if arguments[:1] == ("activate-pid",)
            else self._RESPONSE_TIMEOUT_SECONDS
        )
        try:
            process.stdin.write(" ".join(arguments) + "\n")
            process.stdin.flush()
            ready, _, _ = select.select([process.stdout], [], [], timeout)
            if not ready:
                self._invalidate()
                return None
            response = process.stdout.readline().strip()
        except (OSError, subprocess.SubprocessError):
            self._invalidate()
            return None
        fields = response.split()
        if len(fields) != 2 or fields[0] != "posted":
            self._invalidate()
            return None
        try:
            timestamp_ns = int(fields[1])
        except ValueError:
            self._invalidate()
            return None
        if timestamp_ns <= 0:
            self._invalidate()
            return None
        return timestamp_ns

    def probe_pid_window(self, pid: int) -> dict[str, Any]:
        """Read bounded PID-bound CGWindow/AX facts from the native actor."""

        process = self._process
        facts: dict[str, Any] = {
            "status": "unavailable",
            "cg_window_count": None,
            "cg_origin": None,
            "ax_window_count": None,
            "devhub_title_match_count": None,
            "ax_window_role_count": None,
            "ax_standard_role_count": None,
            "ax_visible_window_count": None,
            "standard_visible_count": None,
            "ax_role_attribute_success_count": None,
            "ax_unknown_role_count": None,
            "ax_hidden_true_count": None,
            "ax_hidden_false_count": None,
        }
        if process is None or process.poll() is not None or process.stdin is None or process.stdout is None:
            return facts
        try:
            process.stdin.write(f"probe-pid {int(pid)}\n")
            process.stdin.flush()
            ready, _, _ = select.select([process.stdout], [], [], 2.0)
            if not ready:
                facts["status"] = "timeout"
                return facts
            response = process.stdout.readline().strip().split()
        except (OSError, subprocess.SubprocessError):
            facts["status"] = "error"
            return facts
        if not response or response[0] != "window-probe":
            facts["status"] = "error"
            return facts
        facts["status"] = "ok"
        names = {
            "cg_count": "cg_window_count",
            "ax_count": "ax_window_count",
            "devhub": "devhub_title_match_count",
            "window_role": "ax_window_role_count",
            "standard_role": "ax_standard_role_count",
            "visible_window": "ax_visible_window_count",
            "standard_visible": "standard_visible_count",
            "role_success": "ax_role_attribute_success_count",
            "unknown_role": "ax_unknown_role_count",
            "hidden_true": "ax_hidden_true_count",
            "hidden_false": "ax_hidden_false_count",
        }
        for field in response[1:]:
            key, separator, value = field.partition("=")
            target = names.get(key)
            if separator != "=" or target is None:
                if key == "cg_origin" and separator == "=" and value != "none":
                    fields = value.split(",")
                    if len(fields) == 2:
                        try:
                            facts["cg_origin"] = [
                                max(-32768, min(32767, int(fields[0]))),
                                max(-32768, min(32767, int(fields[1]))),
                            ]
                        except ValueError:
                            pass
                continue
            try:
                facts[target] = max(0, min(64, int(value)))
            except ValueError:
                continue
        return facts

    def __enter__(self) -> "_NativeInput":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


class _ProcessHandle:
    """Small process identity handle for NSWorkspace-launched bundles."""

    def __init__(self, pid: int, popen: subprocess.Popen[bytes] | None = None):
        self.pid = pid
        self._popen = popen
        self.cleanup_error: str | None = None

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


class _NativeAppQuitter:
    """Request one exact process's ordinary Cocoa termination path."""

    def __init__(self, executable: Path):
        self.executable = executable

    @classmethod
    def build(cls) -> "_NativeAppQuitter | None":
        if platform.system() != "Darwin" or shutil.which("swiftc") is None:
            return None
        source = ROOT / "scripts" / "q5-native-quit.swift"
        if not source.is_file():
            return None
        output = Path(tempfile.gettempdir()) / f"devhub-q52-native-quit-{os.getpid()}"
        module_cache = Path(tempfile.gettempdir()) / f"devhub-q52-swift-quit-cache-{os.getpid()}"
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

    def request(self, executable: Path, pid: int) -> NativeQuitResult:
        try:
            result = subprocess.run(
                [str(self.executable), str(executable), str(pid)],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                text=True,
                timeout=3.5,
            )
        except (OSError, subprocess.SubprocessError):
            return NativeQuitResult("request_rejected")
        if result.returncode != 0:
            return NativeQuitResult("request_rejected")
        category = (result.stdout or "").strip()
        if category not in Q5_QUIT_OUTCOMES:
            return NativeQuitResult("request_rejected")
        return NativeQuitResult(category)  # type: ignore[arg-type]


_NATIVE_APP_QUITTER: _NativeAppQuitter | None = None


def _window_probe(pid: int) -> dict[str, Any]:
    """Return bounded PID-bound AX facts without exposing window titles.

    This is intentionally a closed probe: it reports only the osascript
    outcome, bounded window count, and the number of exact ``DevHub`` title
    matches.  It does not return arbitrary titles, which keeps stale-window
    diagnostics content-free while still distinguishing a missing window from
    a legitimate second Settings window.
    """

    script = f"""
tell application "System Events"
    try
        set targetProcess to first application process whose unix id is {int(pid)}
        set windowCount to count of windows of targetProcess
        set devhubTitleMatchCount to 0
        repeat with candidateWindow in windows of targetProcess
            try
                if (name of candidateWindow as text) is "DevHub" then
                    set devhubTitleMatchCount to devhubTitleMatchCount + 1
                end if
            end try
        end repeat
        set boundedWindowCount to windowCount
        if boundedWindowCount > 64 then set boundedWindowCount to 64
        set boundedTitleMatchCount to devhubTitleMatchCount
        if boundedTitleMatchCount > 64 then set boundedTitleMatchCount to 64
        if windowCount is 1 then
            set windowPosition to position of window 1 of targetProcess
            return "ok|count:" & boundedWindowCount & "|devhub:" & boundedTitleMatchCount & "|position:" & windowPosition
        end if
        return "ok|count:" & boundedWindowCount & "|devhub:" & boundedTitleMatchCount
    on error
        return "error"
    end try
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
        return {
            "osascript_status": "exception",
            "window_count": None,
            "devhub_title_match_count": None,
        }
    output = result.stdout.strip()
    facts: dict[str, Any] = {
        "osascript_status": "ok" if result.returncode == 0 else "error",
        "window_count": None,
        "devhub_title_match_count": None,
    }
    if result.returncode != 0 or not output:
        return facts
    fields = [field.strip() for field in output.split("|")]
    if fields[0] != "ok":
        facts["osascript_status"] = "error"
        return facts
    for field in fields[1:]:
        key, separator, value = field.partition(":")
        if not separator or key not in {"count", "devhub"}:
            continue
        try:
            parsed = max(0, min(64, int(value)))
        except ValueError:
            continue
        facts["window_count" if key == "count" else "devhub_title_match_count"] = parsed
    return facts


def _window_origin(pid: int) -> tuple[int, int] | None:
    """Return the launched process's only visible window origin.

    Process names are not an identity boundary: a stale DevHub instance can
    have the same name while a measured instance is starting.  Bind every
    accessibility query to the Popen PID and require exactly one window until
    the closed probe proves a title-bound main-window rule is appropriate.
    """

    facts = _window_probe(pid)
    if facts.get("osascript_status") != "ok" or facts.get("window_count") != 1:
        return None
    script = f"""
tell application "System Events"
    set targetProcess to first application process whose unix id is {int(pid)}
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
    fields = [field.strip() for field in result.stdout.split(",")]
    if len(fields) < 2:
        return None
    try:
        return int(float(fields[0])), int(float(fields[1]))
    except ValueError:
        return None


def _pid_window_origin(facts: Mapping[str, Any] | None) -> tuple[int, int] | None:
    """Select one PID-bound CGWindow only after closed identity checks pass.

    Direct debug executables can expose their AppKit window through CGWindow
    before System Events reports an application-process window.  The fallback
    is deliberately stricter than choosing the first window: one on-screen
    layer-0 CGWindow, one AX window, and exactly one static ``DevHub`` title
    match must all agree before its bounded origin is used.
    """

    if not isinstance(facts, Mapping) or facts.get("status") != "ok":
        return None
    if (
        facts.get("cg_window_count") != 1
        or facts.get("ax_window_count") != 1
        or facts.get("devhub_title_match_count") != 1
    ):
        return None
    origin = facts.get("cg_origin")
    if not isinstance(origin, list) or len(origin) != 2:
        return None
    if not all(isinstance(value, int) for value in origin):
        return None
    return origin[0], origin[1]


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


def _request_process_quit(executable: Path, pid: int) -> NativeQuitResult:
    """Request clean process termination without driving native UI."""

    global _NATIVE_APP_QUITTER
    if _NATIVE_APP_QUITTER is None:
        _NATIVE_APP_QUITTER = _NativeAppQuitter.build()
    if _NATIVE_APP_QUITTER is None:
        return NativeQuitResult("request_rejected")
    return _NATIVE_APP_QUITTER.request(executable, pid)


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


def _q5_pid_has_executable(pid: int, expected: Path) -> bool:
    """Match one live PID's exact executable image without trusting argv."""

    lsof = shutil.which("lsof")
    if lsof is None:
        return False
    try:
        result = subprocess.run(
            [lsof, "-a", "-p", str(pid), "-d", "txt", "-Fn"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    paths = [Path(line[1:]) for line in result.stdout.splitlines() if line.startswith("n/")]
    expected = expected.resolve()
    return sum(path.resolve() == expected for path in paths) == 1


def _q5_pid_is_live(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True
    return True


def _q5_live_agent_count(pid_dir: Path, commands: Path) -> int | None:
    """Count only ledger Agents whose exact executable image is still live."""

    live = 0
    for pid_file in sorted(pid_dir.glob("*.pid")):
        match = re.fullmatch(r"(codex|claude)\.(\d+)\.pid", pid_file.name)
        if match is None:
            return None
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return None
        if pid <= 1 or pid != int(match.group(2)):
            return None
        expected = (commands / match.group(1)).resolve()
        if _q5_pid_is_live(pid):
            if not _q5_pid_has_executable(pid, expected):
                return None
            live += 1
    return live


def _cleanup_q5_agent_ledger(pid_dir: Path, commands: Path) -> bool:
    """Stop only deterministic Agents proven by PID file and executable.

    The executable lives under this run's still-present private HOME. Exact
    image matching makes PID reuse fail closed: a recycled PID is never
    signalled merely because a stale ledger file contains the same integer.
    """

    records: list[tuple[Path, int, Path]] = []
    for pid_file in sorted(pid_dir.glob("*.pid")):
        match = re.fullmatch(r"(codex|claude)\.(\d+)\.pid", pid_file.name)
        if match is None:
            return False
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return False
        if pid <= 1 or pid != int(match.group(2)):
            return False
        records.append((pid_file, pid, (commands / match.group(1)).resolve()))

    for _pid_file, pid, expected_executable in records:
        if not _q5_pid_is_live(pid):
            continue
        if not _q5_pid_has_executable(pid, expected_executable):
            return False
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if all(not _q5_pid_is_live(pid) for _pid_file, pid, _expected in records):
            break
        time.sleep(0.05)

    for _pid_file, pid, expected_executable in records:
        if not _q5_pid_is_live(pid):
            continue
        if not _q5_pid_has_executable(pid, expected_executable):
            return False
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            pass

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if all(not _q5_pid_is_live(pid) for _pid_file, pid, _expected in records):
            break
        time.sleep(0.05)
    if any(_q5_pid_is_live(pid) for _pid_file, pid, _expected in records):
        return False
    for pid_file, _pid, _expected in records:
        try:
            pid_file.unlink(missing_ok=True)
        except OSError:
            return False
    return not any(pid_dir.glob("*.pid"))


def _q5_home_quiescent(home: Path) -> bool:
    """Require two empty exact-HOME open-file scans before deletion."""

    lsof = shutil.which("lsof")
    if lsof is None:
        return False
    deadline = time.monotonic() + 5.0
    empty_scans = 0
    while time.monotonic() < deadline:
        try:
            result = subprocess.run(
                [lsof, "-t", "+D", str(home)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                text=True,
                timeout=2,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        if result.returncode not in {0, 1}:
            return False
        if not result.stdout.strip():
            empty_scans += 1
            if empty_scans >= 2:
                return True
        else:
            empty_scans = 0
        time.sleep(0.08)
    return False


def _remove_q5_fixture_home(home: Path) -> bool:
    """Delete an exact private HOME only after its owners have quiesced."""

    if not _q5_home_quiescent(home):
        return False
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        try:
            shutil.rmtree(home)
        except FileNotFoundError:
            return True
        except OSError:
            time.sleep(0.05)
            continue
        if not home.exists():
            return True
    return not home.exists()


@dataclass
class _Q5OwnedFixture:
    home: Path
    commands: Path | None
    pid_dir: Path
    tmux_tmpdir: Path
    active_process: _ProcessHandle | None = None
    app_pid: int = 0
    stop_herdr_first: bool = False


def _q5_secure_runtime_root() -> Path:
    """Return the one owner-only parent allowed for Q5 security state."""

    runtime_root = Path.home() / ".dhq5"
    try:
        runtime_root.mkdir(mode=0o700, exist_ok=True)
        metadata = runtime_root.lstat()
    except OSError as error:
        raise OSError("q5_secure_runtime_root_unavailable") from error
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise OSError("q5_secure_runtime_root_invalid")
    return runtime_root


@contextlib.contextmanager
def _q5_owned_fixture_home(
    prefix: str, *, deterministic_agents: bool = True
) -> Iterator[_Q5OwnedFixture]:
    """Keep the ownership handles alive until every Q5 process is gone."""

    # Diagnostics deliberately rejects a HOME below a sticky world-writable
    # ancestor such as /private/tmp. Keep this ephemeral root directly below
    # the invoking user's owned HOME so the secure-path contract is realistic
    # and Herdr's Unix socket remains below the platform path-length limit. The
    # root is removed once the exact fixture process ledger is quiescent.
    runtime_root = _q5_secure_runtime_root()
    home = Path(tempfile.mkdtemp(prefix=prefix, dir=runtime_root)).resolve()
    fixture: _Q5OwnedFixture | None = None
    try:
        _q5_socket_path_preflight(home)
        commands = _prepare_q5_agent_commands(home) if deterministic_agents else None
        _seed_native_config(home, commands)
        if commands is not None:
            _q5_fixture_preflight(home, commands)
        pid_dir = home / ".q5-pids"
        pid_dir.mkdir(mode=0o700)
        tmux_tmpdir = home / ".tmux"
        tmux_tmpdir.mkdir(mode=0o700)
        fixture = _Q5OwnedFixture(home, commands, pid_dir, tmux_tmpdir)
        yield fixture
    finally:
        if fixture is None:
            try:
                shutil.rmtree(home)
            except OSError:
                pass
            if home.exists():
                raise OSError("fixture_home_cleanup_incomplete")
        else:
            herdr_stopped = True
            if fixture.stop_herdr_first:
                herdr_stopped = _stop_owned_herdr(fixture.home)
            if fixture.active_process is not None and fixture.active_process.poll() is None:
                _stop_owned_process(fixture.active_process, graceful=False)
            if not fixture.stop_herdr_first:
                herdr_stopped = _stop_owned_herdr(fixture.home)
            agents_stopped = (
                _cleanup_q5_agent_ledger(fixture.pid_dir, fixture.commands)
                if fixture.commands is not None
                else True
            )
            children_stopped = _cleanup_owned_processes(fixture.home, fixture.app_pid)
            tmux_stopped = _cleanup_owned_tmux(fixture.tmux_tmpdir)
            home_removed = (
                _remove_q5_fixture_home(fixture.home)
                if herdr_stopped and agents_stopped and children_stopped and tmux_stopped
                else False
            )
            if not (
                herdr_stopped
                and agents_stopped
                and children_stopped
                and tmux_stopped
                and home_removed
            ):
                raise OSError("persistent_relaunch_cleanup_incomplete")
        try:
            runtime_root.rmdir()
        except OSError:
            pass


def _secure_provider_check_status(
    command: Sequence[str], timeout: float = 120.0
) -> dict[str, Any]:
    """Run a provider harness below an exactly-owned short secure parent."""

    try:
        with _q5_owned_fixture_home(
            "c-", deterministic_agents=False
        ) as fixture:
            environment = os.environ.copy()
            environment["DEVHUB_Q5_SECURE_RUN_ROOT"] = str(fixture.home)
            return _command_status(command, timeout, environment=environment)
    except OSError:
        return {
            "status": "fail",
            "exit_code": None,
            "timed_out": False,
            "elapsed_ms": 0.0,
            "cleanup_status": "failed",
        }


def _owned_provider_pids(
    home: Path, app_pid: int, provider: ProviderArtifact | None
) -> list[int]:
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
    provider_marker = "serve-web" if isinstance(provider, OfficialVSCodeArtifact) else "openvscode-server"
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or home_text not in fields[1] or provider_marker not in fields[1]:
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


def _kill_owned_provider(home: Path, app_pid: int, provider: ProviderArtifact | None) -> int:
    """Crash one managed provider child for one isolated run."""

    pids = _owned_provider_pids(home, app_pid, provider)
    for pid in pids[:1]:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    return len(pids)


def _stop_owned_process(process: _ProcessHandle, *, graceful: bool) -> None:
    """Stop one exact app PID with a bounded cleanup policy.

    Disposable timing attempts must not spend the graceful termination budget:
    their isolated HOME and private tmux namespace are thrown away after the
    marker boundary.  The graceful policy is reserved for the quit/relaunch
    lifecycle harness, where clean state and provider retention are evidence.
    """

    if process.poll() is not None:
        return
    if graceful:
        process.terminate()
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
    openvscode: ProviderArtifact | None,
    *,
    seed_picker: bool = False,
    cleanup_policy: Literal["fast", "graceful"] = "fast",
    scale_fixture: bool = False,
) -> Iterator[tuple[_ProcessHandle, Path, Path, float]]:
    """Launch one real app with a canonical isolated HOME."""

    q5_scale_fixture = scale_fixture or os.environ.get("DEVHUB_Q5_SCALE_FIXTURE") == "1"
    with _q5_owned_fixture_home(
        "dh-q5-", deterministic_agents=q5_scale_fixture
    ) as fixture:
        safe_home = fixture.home
        agent_commands = fixture.commands
        q5_pid_dir = fixture.pid_dir
        tmux_tmpdir = fixture.tmux_tmpdir
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
        environment["XDG_CONFIG_HOME"] = str(safe_home / ".config")
        environment["XDG_STATE_HOME"] = str(safe_home / ".state")
        environment["XDG_DATA_HOME"] = str(safe_home / ".data")
        # tmux's socket namespace is independent from HOME.  Keep every
        # measured launch in a private, trusted namespace so a prior run
        # cannot make its Scratch identity collide with this run.
        environment["TMUX_TMPDIR"] = str(tmux_tmpdir)
        environment["DEVHUB_Q5_PERFORMANCE"] = "1"
        if q5_scale_fixture:
            environment["DEVHUB_Q5_SCALE_FIXTURE"] = "1"
            environment["DEVHUB_Q5_MARKER_FILE"] = str(safe_home / ".q5-markers")
            environment["DEVHUB_HERDR_TRACE_FILE"] = str(safe_home / ".q5-agent-trace")
            environment["DEVHUB_HERDR_PID_DIR"] = str(q5_pid_dir)
            environment["DEVHUB_HERDR_HARNESS"] = "1"
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
            fixture.app_pid = process.pid
            fixture.active_process = process
        except OSError:
            raise
        try:
            yield process, safe_home, log_file, started
        finally:
            _stop_owned_process(process, graceful=cleanup_policy == "graceful")
            fixture.active_process = None if process.poll() is not None else process
            if bundle is not None and process.cleanup_error is None:
                quiescer = _NATIVE_BUNDLE_QUIESCER
                if quiescer is None or not quiescer.wait(bundle, process.pid):
                    process.cleanup_error = "bundle_quiescence"
            if process.cleanup_error is not None:
                raise OSError(process.cleanup_error)


def _cleanup_owned_tmux(tmux_tmpdir: Path) -> bool:
    """Stop only the private tmux server created by one measured launch."""

    tmux = shutil.which("tmux")
    if tmux is None:
        return True
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
        return False
    try:
        probe = subprocess.run(
            [tmux, "-L", "devhub", "list-sessions"],
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return probe.returncode != 0


def _launch_shell_attempt(executable: Path, openvscode: ProviderArtifact | None) -> dict[str, Any]:
    """Launch DevHub and wait for the AppShell marker, retaining no output."""

    try:
        with _running_app(executable, openvscode) as (
            process,
            _safe_home,
            log_file,
            started,
        ):
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
            return {
                "status": status,
                "elapsed_ms": elapsed,
                "marker": "app_shell_interactive",
                "reason": reason,
            }
    except OSError as error:
        reason = str(error)
        if reason not in _NATIVE_LAUNCH_FAILURES:
            reason = "owned_cleanup_incomplete"
        return {
            "status": "unavailable" if reason in _NATIVE_LAUNCH_FAILURES else "blocked",
            "elapsed_ms": None,
            "marker": "app_shell_interactive",
            "reason": reason,
        }


def _marker_attempt(
    executable: Path,
    openvscode: ProviderArtifact | None,
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
    openvscode: ProviderArtifact | None,
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
    openvscode: ProviderArtifact | None,
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
    openvscode: ProviderArtifact | None,
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
    openvscode: ProviderArtifact | None,
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
                "app_pid": process.pid,
                "provider_pids": _owned_provider_pids(home, process.pid, openvscode),
                "reason": "ten exact-PID close/reopen cycles completed",
            }
    except OSError as error:
        reason = str(error)
        if reason not in _NATIVE_LAUNCH_FAILURES and not reason.startswith("launch_callback_error:"):
            reason = "devhub_launch_unavailable"
        return {
            "status": "blocked",
            "cycles_required": cycles,
            "cycles_completed": completed,
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


def _editor_scale_probe(
    executable: Path,
    openvscode: ProviderArtifact | None,
) -> dict[str, Any]:
    """Observe real EditorHost/Bridge scale facts without inventing agents.

    The probe is deliberately conservative: the scale fixture is created by
    the Rust coordinator through normal intents and real Herdr effects. The
    report retains only typed marker counts and EditorHost lifecycle facts.
    """

    try:
        with _running_app(executable, openvscode, scale_fixture=True) as (process, home, log_file, _started):
            shell_ok, offset, _ = _wait_for_marker(log_file, "app_shell_interactive", 0)
            # Scale evidence is owned by the Rust reconstruction/Bridge
            # markers. A missing App Shell timing marker is retained as a
            # diagnostic fact but must not prevent the real EditorHost fixture
            # from reaching its bounded 300-second setup deadline.
            if not shell_ok:
                offset = 0
            # The Rust sink emits one first-ready marker per stable surface.
            # Wait only for the authoritative count; no timeout is converted
            # to a synthetic sample.
            # Eight real OpenVSCode mounts plus sixteen real Herdr launches
            # are intentionally allowed a bounded five-minute setup window.
            # The Q5 fixture setup is deliberately outside timing budgets:
            # sixteen real Herdr interactive starts may each consume their
            # bounded readiness window on a cold native host.
            fixture_deadline = time.monotonic() + 900.0
            fixture_ready = False
            terminal_failure: str | None = None
            while time.monotonic() < fixture_deadline:
                markers = _performance_markers(log_file)
                fixture_ready = "q5_fixture_scale_ready" in markers
                terminal_failure = _q5_fixture_terminal_failure(markers)
                if fixture_ready:
                    break
                if terminal_failure is not None:
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.05)
            if terminal_failure is not None:
                return {
                    "status": "blocked",
                    "reason": terminal_failure,
                    "observed_editor_webviews": 0,
                    "observed_bridge_ready_surfaces": 0,
                    "agent_count": None,
                    "hidden_continuity": "not_executed",
                    "startup_reconstruction": (
                        "failed" if terminal_failure == "startup_reconstruction_failed" else "pending"
                    ),
                    "dispatch_diagnostics": _q5_dispatch_diagnostics(home),
                    "cleanup_status": process.cleanup_error or "passed",
                }
            deadline = time.monotonic() + 120.0
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
            markers = _performance_markers(log_file)
            dispatch_diagnostics = _q5_dispatch_diagnostics(home)
            workspace_count = markers.count("q5_fixture_workspace_ready")
            agent_count = markers.count("q5_fixture_agent_ready")
            distribution_facts = _q5_counter_facts(home, "workspace_agent_count")
            distribution = [
                fact["value"]
                for fact in sorted(distribution_facts, key=lambda item: item.get("index", -1))
                if "index" in fact
            ]
            bridge_generations = [fact["value"] for fact in _q5_counter_facts(home, "bridge_generation")]
            provider_pids = _owned_provider_pids(home, process.pid, openvscode)
            if (
                not fixture_ready
                or workspace_count != 8
                or agent_count != 16
                or len(distribution) != 8
                or sum(distribution) != 16
                or sum(count > 0 for count in distribution) < 4
                or mounted < 9
                or bridge_ready < 9
            ):
                return {
                    "status": "blocked",
                    "reason": "real_q5_fixture_did_not_reconcile_exact_scale",
                    "observed_editor_webviews": mounted,
                    "observed_bridge_ready_surfaces": bridge_ready,
                    "workspace_count": workspace_count,
                    "agent_count": agent_count,
                    "observed_workspace_distribution": distribution,
                    "workspace_agent_counts": distribution,
                    "app_pid": process.pid,
                    "provider_pids": provider_pids,
                    "bridge_generations": bridge_generations,
                    "hidden_continuity": "not_executed",
                    "lifecycle_facts": facts,
                    "dispatch_diagnostics": dispatch_diagnostics,
                    "last_marker": markers[-1] if markers else None,
                    "ordered_markers": markers,
                    "herdr_runtime_observations": agent_count,
                    "cleanup_status": process.cleanup_error or "passed",
                }
            hidden_started = time.monotonic()
            hidden_start_deadline = hidden_started + 20.0
            while time.monotonic() < hidden_start_deadline and "q5_hidden_hold_started" not in _performance_markers(log_file):
                if process.poll() is not None:
                    break
                time.sleep(0.05)
            hidden_hold_started = "q5_hidden_hold_started" in _performance_markers(log_file)
            hidden_verified = False
            hidden_duration_seconds: float | None = None
            if hidden_hold_started:
                hidden_deadline = time.monotonic() + _q5_hidden_observation_budget_seconds()
                while time.monotonic() < hidden_deadline:
                    hidden_verified = "q5_hidden_continuity_verified" in _performance_markers(log_file)
                    if hidden_verified:
                        break
                    if process.poll() is not None:
                        break
                    time.sleep(0.25)
            hidden_fact = _q5_hidden_continuity_fact(home)
            # Retain the authoritative post-hold sequence rather than the
            # pre-hold scale snapshot captured above. This is reporting-only;
            # timing still comes from the Rust-owned fact.
            markers = _performance_markers(log_file)
            if hidden_fact is not None:
                hidden_duration_seconds = round(hidden_fact["duration_ms"] / 1000.0, 3)
            hidden_budget_satisfied = (
                isinstance(hidden_duration_seconds, (int, float))
                and hidden_duration_seconds >= 600
            )
            identity_check = (
                hidden_fact is not None
                and hidden_fact["baseline_count"] >= 9
                and hidden_fact["current_count"] >= 9
                and hidden_fact["hidden_count"] >= 5
                and hidden_fact["missing_count"] == 0
                and hidden_fact["generation_mismatch_count"] == 0
                and hidden_fact["context_mismatch_count"] == 0
                and hidden_fact["active_editor"] == "workspace"
            )
            bridge_check = (
                hidden_fact is not None
                and hidden_fact["missing_count"] == 0
                and hidden_fact["disconnected_count"] == 0
                and hidden_fact["owner_missing_count"] == 0
                and hidden_fact["owner_lookup_result"] == "ok"
            )
            dirty_check = (
                hidden_fact is not None
                and hidden_fact["missing_count"] == 0
                and hidden_fact["dirty_mismatch_count"] == 0
                and hidden_fact["continuity"] == "pass"
            )
            continuity_verified = (
                hidden_verified
                and hidden_budget_satisfied
                and identity_check
                and bridge_check
                and dirty_check
            )
            return {
                "status": "covered" if continuity_verified else "blocked",
                "reason": "Rust-owned hidden identity, Bridge, and dirty-state continuity reconciled exact counts" if continuity_verified else "hidden process-owned continuity was not verified",
                "observed_editor_webviews": mounted,
                "observed_bridge_ready_surfaces": bridge_ready,
                "workspace_count": workspace_count,
                "agent_count": agent_count,
                "observed_workspace_distribution": distribution,
                "workspace_agent_counts": distribution,
                "app_pid": process.pid,
                "provider_pids": provider_pids,
                "bridge_generations": bridge_generations,
                "hidden_continuity": "verified" if continuity_verified else "not_executed",
                "observed_hidden_surfaces": (
                    hidden_fact["hidden_count"] if hidden_fact is not None else 0
                ),
                "observed_hidden_minutes": round((hidden_duration_seconds or 0.0) / 60.0, 3),
                "hidden_duration_seconds": hidden_duration_seconds,
                "hidden_checks": {
                    "load_identity": "pass" if identity_check else "pending" if hidden_fact is None else "fail",
                    "bridge_connection": "pass" if bridge_check else "pending" if hidden_fact is None else "fail",
                    "dirty_state": "pass" if dirty_check else "pending" if hidden_fact is None else "fail",
                },
                "hidden_owner_continuity": (
                    "verified"
                    if hidden_fact is not None and hidden_fact["continuity"] == "pass"
                    else "failed"
                    if hidden_fact is not None
                    else "not_observed"
                ),
                "hidden_continuity_fact": hidden_fact,
                "lifecycle_facts": facts,
                "dispatch_diagnostics": dispatch_diagnostics,
                "last_marker": markers[-1] if markers else None,
                "ordered_markers": markers,
                "herdr_runtime_observations": agent_count,
                "cleanup_status": process.cleanup_error or "passed",
            }
    except OSError as error:
        message = str(error)
        if message in {
            "owned_cleanup",
            "bundle_quiescence",
            "herdr_cleanup",
            "tmux_cleanup",
            "agent_ledger_cleanup",
            "home_quiescence",
        }:
            stage = message
        elif message in {"bundle_quiescer_unavailable", "bundle_instance_registered", "prior_bundle_instance_registered", "native bundle launcher unavailable"}:
            stage = "spawn"
        elif message.startswith("q5_") or message in {"clang_or_cc_unavailable"}:
            stage = "preflight"
        else:
            stage = "spawn"
        safe_reason = message if message in _NATIVE_LAUNCH_FAILURES else "unclassified"
        return {
            "status": "blocked",
            "reason": f"q5_{stage}_{safe_reason}",
            "observed_editor_webviews": 0,
            "observed_bridge_ready_surfaces": 0,
            "agent_count": None,
            "hidden_continuity": "not_executed",
            "cleanup_status": "not_started" if stage in {"preflight", "spawn"} else stage,
        }


def _q5_quit_relaunch_matrix_inner(
    executable: Path, openvscode: ProviderArtifact | None
) -> dict[str, Any]:
    """Exercise five process-targeted Quit/relaunch cycles over one isolated HOME."""

    cycle_facts: list[dict[str, Any]] = []
    if _bundle_for_executable(executable) is not None:
        # LaunchServices owns bundle registration and is intentionally kept in
        # the window-reconstruction driver. A direct debug executable is the
        # exact process identity needed for this persistent provider matrix.
        executable = executable
    try:
        with _q5_owned_fixture_home("dh-q5-r-") as fixture:
            safe_home = fixture.home
            if fixture.commands is None:
                raise OSError("q5_agent_executable_unavailable")
            agent_commands = fixture.commands
            q5_pid_dir = fixture.pid_dir
            tmux_tmpdir = fixture.tmux_tmpdir
            environment = _provider_environment(os.environ, openvscode)
            environment.update(
                {
                    "HOME": str(safe_home),
                    "XDG_CONFIG_HOME": str(safe_home / ".config"),
                    "XDG_STATE_HOME": str(safe_home / ".state"),
                    "XDG_DATA_HOME": str(safe_home / ".data"),
                    "TMUX_TMPDIR": str(tmux_tmpdir),
                    "DEVHUB_Q5_PERFORMANCE": "1",
                    "DEVHUB_Q5_SCALE_FIXTURE": "1",
                    "DEVHUB_Q5_SKIP_HIDDEN": "1",
                    "DEVHUB_Q5_MARKER_FILE": str(safe_home / ".q5-markers"),
                    "DEVHUB_HERDR_TRACE_FILE": str(safe_home / ".q5-agent-trace"),
                    "DEVHUB_HERDR_PID_DIR": str(q5_pid_dir),
                    "DEVHUB_HERDR_HARNESS": "1",
                }
            )
            log_file = safe_home / "Library" / "Logs" / "DevHub" / "devhub.jsonl"
            completed = 0
            app_pids: list[int] = []
            provider_pids: list[list[int]] = []
            port_available_before_launch: list[bool | None] = []
            port_available_after_quit: list[bool | None] = []
            retained_editor_process_counts: list[int] = []
            retained_agents = 0
            cycles_to_run = 2 if os.environ.get("DEVHUB_Q5_RELAUNCH_REPRO") == "1" else 5
            for cycle in range(cycles_to_run):
                port_available_before_launch.append(
                    _q5_editor_port_available(safe_home, openvscode)
                )
                ready_count_before_launch = _performance_marker_count(
                    log_file, "q5_fixture_scale_ready"
                )
                relaunch_fact_count_before_launch = len(_q5_relaunch_state_facts(safe_home))
                terminal_failure_markers = (
                    "q5_fixture_agent_dispatch_failed",
                    "q5_fixture_start_failed",
                    "q5_fixture_start_skipped",
                )
                terminal_failure_counts = {
                    marker: _performance_marker_count(log_file, marker)
                    for marker in terminal_failure_markers
                }
                process = subprocess.Popen(
                    [str(executable)],
                    cwd=ROOT,
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                app_pids.append(process.pid)
                fixture.app_pid = process.pid
                fixture.active_process = _ProcessHandle(process.pid, process)
                ready_deadline = time.monotonic() + 300.0
                ready = False
                while time.monotonic() < ready_deadline:
                    markers = _performance_markers(log_file)
                    marker_counts = {
                        marker: _performance_marker_count(log_file, marker)
                        for marker in terminal_failure_markers
                    }
                    terminal_failure = _q5_fixture_terminal_failure(
                        tuple(
                            marker
                            for marker in terminal_failure_markers
                            if marker_counts[marker] > terminal_failure_counts[marker]
                        )
                    )
                    if terminal_failure is not None:
                        return {
                            "status": "blocked",
                            "cycles_required": 5,
                            "cycles_completed": completed,
                            "agents_retained": 0,
                            "tmux_sessions_retained": 0,
                            "reason": terminal_failure,
                            "workspace_count": markers.count("q5_fixture_workspace_ready"),
                            "agent_ready_count": markers.count("q5_fixture_agent_ready"),
                            "dispatch_diagnostics": _q5_dispatch_diagnostics(safe_home),
                            "reconstruction_diagnostics": _q5_reconstruction_diagnostics(
                                safe_home
                            ),
                            "state_shape": _q5_state_shape(safe_home),
                            "ordered_markers": markers[-128:],
                            "editor_port_available_before_launch": port_available_before_launch,
                            "editor_port_available_after_quit": port_available_after_quit,
                            "retained_editor_process_counts": retained_editor_process_counts,
                            "app_pids": app_pids,
                            "cycle_facts": cycle_facts,
                        }
                    ready = (
                        _performance_marker_count(log_file, "q5_fixture_scale_ready")
                        > ready_count_before_launch
                    )
                    if ready:
                        break
                    if process.poll() is not None:
                        break
                    time.sleep(0.1)
                quit_result = (
                    _request_process_quit(executable, process.pid)
                    if ready
                    else NativeQuitResult("request_rejected")
                )
                if not ready or not quit_result.accepted:
                    _stop_owned_process(_ProcessHandle(process.pid, process), graceful=False)
                    return {
                        "status": "blocked",
                        "cycles_required": 5,
                        "cycles_completed": completed,
                        "agents_retained": 0,
                        "tmux_sessions_retained": 0,
                        "reason": (
                            "scale fixture or process-targeted Quit did not complete"
                            if not ready
                            else f"process_quit_{quit_result.category}"
                        ),
                        "app_pids": app_pids,
                        "quit_outcome": quit_result.category,
                        "cycle_facts": cycle_facts,
                    }
                relaunch_facts = _q5_relaunch_state_facts(safe_home)
                relaunch_fact = (
                    relaunch_facts[-1]
                    if len(relaunch_facts) == relaunch_fact_count_before_launch + 1
                    else None
                )
                if relaunch_fact is None or relaunch_fact != {
                    "workspace_count": 8,
                    "agent_count": 16,
                    "mapping_count": 16,
                    "surface_count": 9,
                    "missing_identity_count": 0,
                    "duplicate_identity_count": 0,
                    "disconnected_count": 0,
                    "not_ready_count": 0,
                    "generation_zero_count": 0,
                    "context_mismatch_count": 0,
                    "active_editor": "workspace",
                    "status": "pass",
                }:
                    return {
                        "status": "blocked",
                        "cycles_required": 5,
                        "cycles_completed": completed,
                        "agents_retained": 0,
                        "tmux_sessions_retained": 0,
                        "reason": "exact relaunch state and Bridge identity were not restored",
                        "cycle_facts": cycle_facts,
                    }
                provider_pids.append(_owned_provider_pids(safe_home, process.pid, openvscode))
                retained_agents_observed = _q5_live_agent_count(q5_pid_dir, agent_commands)
                retained_agents = retained_agents_observed or 0
                try:
                    process.wait(timeout=30)
                    fixture.active_process = None
                except subprocess.TimeoutExpired:
                    _stop_owned_process(_ProcessHandle(process.pid, process), graceful=False)
                    return {
                        "status": "blocked",
                        "cycles_required": 5,
                        "cycles_completed": completed,
                        "agents_retained": 0,
                        "tmux_sessions_retained": 0,
                        "reason": "process-targeted Quit did not terminate the owned app",
                        "app_pids": app_pids,
                        "provider_pids": provider_pids,
                        "quit_outcome": quit_result.category,
                        "cycle_facts": cycle_facts,
                    }
                if os.environ.get("DEVHUB_Q5_RELAUNCH_RELEASE_WAIT") == "1":
                    time.sleep(2.0)
                port_release = _q5_wait_editor_port_release(
                    safe_home, openvscode, provider_pids[-1]
                )
                port_available_after_quit.append(port_release["available"])
                retained_editor_pids = _owned_provider_pids(safe_home, process.pid, openvscode)
                retained_editor_process_counts.append(len(retained_editor_pids))
                port_available = port_available_after_quit[-1] is True
                tmux = shutil.which("tmux")
                sessions = 0
                if tmux is not None:
                    result = subprocess.run(
                        [tmux, "-L", "devhub", "list-sessions"],
                        env=environment,
                        cwd=ROOT,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                        check=False,
                        text=True,
                    )
                    sessions = len([line for line in result.stdout.splitlines() if line.strip()])
                state_shape = _q5_state_shape(safe_home)
                state_restored = state_shape == {
                    "status": "present",
                    "schema_version": 1,
                    "workspace_count": 8,
                    "agent_count": 16,
                    "provider_mapping_count": 16,
                    "shutdown_clean": True,
                }
                cycle_fact = {
                    "cycle": cycle + 1,
                    "quit_outcome": quit_result.category,
                    "shutdown_clean": state_shape.get("shutdown_clean") is True,
                    "port_available_after_quit": port_available,
                    "selected_provider_port_file": port_release[
                        "selected_provider_port_file"
                    ],
                    "port_release_category": port_release["category"],
                    "listener_count_after_quit": port_release["listener_count"],
                    "listener_owned_by_fixture": port_release[
                        "listener_owned_by_fixture"
                    ],
                    "retained_editor_process_count": len(retained_editor_pids),
                    "navigation_restored": relaunch_fact["active_editor"] == "workspace",
                    "workspace_count": relaunch_fact["workspace_count"],
                    "agent_count": relaunch_fact["agent_count"],
                    "mapping_count": relaunch_fact["mapping_count"],
                    "bridge_surface_count": relaunch_fact["surface_count"],
                    "bridge_identity_ready": all(
                        relaunch_fact[name] == 0
                        for name in (
                            "missing_identity_count",
                            "duplicate_identity_count",
                            "context_mismatch_count",
                        )
                    ),
                    "bridge_generation_ready": relaunch_fact["generation_zero_count"] == 0,
                    "bridge_connection_ready": (
                        relaunch_fact["disconnected_count"] == 0
                        and relaunch_fact["not_ready_count"] == 0
                    ),
                    "agents_retained": retained_agents,
                    "tmux_sessions_retained": sessions,
                    "state_restored": state_restored,
                }
                cycle_facts.append(cycle_fact)
                if (
                    not port_available
                    or retained_editor_pids
                    or not state_restored
                    or not cycle_fact["shutdown_clean"]
                    or sessions < 2
                    or retained_agents_observed is None
                    or retained_agents < 2
                ):
                    return {
                        "status": "blocked",
                        "cycles_required": 5,
                        "cycles_completed": completed,
                        "agents_retained": retained_agents,
                        "tmux_sessions_retained": sessions,
                        "reason": "one or more exact relaunch acceptance facts failed",
                        "cycle_facts": cycle_facts,
                        "app_pids": app_pids,
                        "provider_pids": provider_pids,
                    }
                completed += 1
            if cycles_to_run < 5:
                return {
                    "status": "blocked",
                    "cycles_required": 5,
                    "cycles_completed": completed,
                    "agents_retained": retained_agents,
                    "tmux_sessions_retained": sessions,
                    "reason": "diagnostic_two_cycle_repro_complete",
                    "state_shape": _q5_state_shape(safe_home),
                    "reconstruction_diagnostics": _q5_reconstruction_diagnostics(safe_home),
                    "editor_port_available_before_launch": port_available_before_launch,
                    "editor_port_available_after_quit": port_available_after_quit,
                    "retained_editor_process_counts": retained_editor_process_counts,
                    "app_pids": app_pids,
                    "provider_pids": provider_pids,
                    "cycle_facts": cycle_facts,
                }
            return {
                "status": "covered",
                "cycles_required": 5,
                "cycles_completed": completed,
                "agents_retained": retained_agents,
                "tmux_sessions_retained": min(
                    fact["tmux_sessions_retained"] for fact in cycle_facts
                ),
                "navigation_restored": all(
                    fact["navigation_restored"] for fact in cycle_facts
                ),
                "cycle_facts": cycle_facts,
                "editor_port_available_after_quit": port_available_after_quit,
                "retained_editor_process_counts": retained_editor_process_counts,
                "app_pids": app_pids,
                "provider_pids": provider_pids,
                "reason": "five exact same-HOME process-targeted Quit/relaunch cycles reconciled providers",
                "cleanup_status": "passed",
            }
    except (OSError, subprocess.SubprocessError) as error:
        if str(error) in {
            "fixture_home_cleanup_incomplete",
            "persistent_relaunch_cleanup_incomplete",
        }:
            raise
        return {
            "status": "blocked",
            "cycles_required": 5,
            "cycles_completed": len(cycle_facts),
            "agents_retained": 0,
            "tmux_sessions_retained": 0,
            "reason": "persistent relaunch fixture unavailable",
            "cycle_facts": cycle_facts,
        }


def _q5_quit_relaunch_matrix(
    executable: Path, openvscode: ProviderArtifact | None
) -> dict[str, Any]:
    try:
        return _q5_quit_relaunch_matrix_inner(executable, openvscode)
    except OSError as error:
        return {
            "status": "blocked",
            "cycles_required": 5,
            "cycles_completed": 0,
            "agents_retained": 0,
            "tmux_sessions_retained": 0,
            "reason": str(error),
            "cleanup_status": "failed",
        }


def _managed_provider_crash_attempt(
    executable: Path,
    provider: ProviderArtifact | None,
    input_driver: _NativeInput | None,
) -> dict[str, Any]:
    """Crash one owned provider child and wait for the real Bridge recovery."""

    marker = "editor_bridge_ready"
    if provider is None:
        return {
            "status": "blocked",
            "isolation_verified": False,
            "recovery_verified": False,
            "reason": "editor_provider_missing",
        }
    try:
        with _running_app(executable, provider) as (process, home, log_file, _started):
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
                killed = _kill_owned_provider(home, process.pid, provider)
                if killed == 0:
                    time.sleep(0.05)
            if killed == 0:
                return {
                    "status": "blocked",
                    "isolation_verified": process.poll() is None,
                    "recovery_verified": False,
                    "reason": "managed_provider_pid_unavailable",
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
                "reason": "managed_provider_crash_recovered",
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
    openvscode: ProviderArtifact | None,
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
    provider: ProviderArtifact | None,
    *,
    run_providers: bool,
    run_interactive: bool = False,
    only_scenario: str | None = None,
    only_scale: bool = False,
) -> dict[str, Any]:
    artifacts = host["artifacts"]
    gui = host["gui"]
    execution_boundary = host["execution_boundary"]
    binary_available = artifacts["devhub_debug_binary"] == "available"
    app_bundle_available = artifacts.get("devhub_debug_app_bundle") == "available"
    gui_available = bool(gui["interactive_session"])
    window_server_available = gui.get("window_server") == "available"
    native_boundary_available = execution_boundary["status"] == "available"
    provider_available = provider is not None
    provider_kind = (
        "official-vscode"
        if isinstance(provider, OfficialVSCodeArtifact)
        else "openvscode"
        if isinstance(provider, OpenVSCodeArtifact)
        else "unavailable"
    )
    blockers: list[str] = []
    if not native_boundary_available:
        blockers.append("native_execution_boundary_unavailable")
    if not binary_available:
        blockers.append("devhub_debug_binary_missing")
    if not provider_available:
        blockers.append("official_vscode_unavailable")
    if isinstance(provider, OfficialVSCodeArtifact) and not provider.license_accepted:
        blockers.append("official_vscode_license_consent_required")
    if not window_server_available:
        blockers.append("window_server_unavailable")
    elif run_interactive and not gui_available:
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
    run_shell = not only_scale and only_scenario in (None, "process_cold_shell")
    provider_consent_ready = not isinstance(provider, OfficialVSCodeArtifact) or provider.license_accepted
    legacy_scale_blocked = isinstance(provider, OpenVSCodeArtifact)
    if run_shell and binary_available and provider_available and provider_consent_ready and window_server_available and native_boundary_available:
        print("q5.2: process_cold_shell setup start", file=sys.stderr, flush=True)
        shell_attempts.append({"role": "setup", **_launch_shell_attempt(binary, provider)})
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
            attempt = _launch_shell_attempt(binary, provider)
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

    # Native input is a manual, user-attended acceptance boundary. The
    # process-only scale/endurance path must not compile or invoke the actor.
    input_driver = (
        _NativeInput.build()
        if run_interactive
        and not only_scale
        and binary_available
        and gui_available
        and native_boundary_available
        else None
    )
    for timing_id in TIMING_IDS:
        if timing_id == "process_cold_shell":
            continue
        if only_scale:
            timing_runs[timing_id] = _timing_entry("scale_endurance_only; timing scenarios not executed")
            continue
        if not run_interactive:
            timing_runs[timing_id] = _timing_entry(
                "user_interaction_environment_deferred"
            )
            continue
        if only_scenario is not None and timing_id != only_scenario:
            timing_runs[timing_id] = _timing_entry(
                f"scenario_filter:{only_scenario}; not executed"
            )
            continue
        if (
            binary_available
            and provider_available
            and provider_consent_ready
            and gui_available
            and native_boundary_available
        ):
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
                timing_id, scenario_binary, provider, input_driver
            )
        else:
            timing_runs[timing_id] = _timing_entry(
                "Native marker-driven run is unavailable; no synthetic timing is recorded."
            )

    provider_checks: dict[str, Any] = {}
    if run_providers:
        provider_checks["herdr_real_runtime"] = {
            "command": "scripts/check-agent-runtime-real.sh",
            **_secure_provider_check_status(
                ("scripts/check-agent-runtime-real.sh",), timeout=180
            ),
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

    scale_blockers = [*blockers]
    if legacy_scale_blocked:
        scale_blockers.append("legacy_openvscode_not_primary")
    native_reason = ";".join(scale_blockers) or "GUI, official VS Code, explicit consent, and reference context are required for this native matrix."
    run_matrices = only_scenario is None
    if (
        run_matrices
        and binary_available
        and provider_available
        and provider_consent_ready
        and not legacy_scale_blocked
        and window_server_available
        and native_boundary_available
    ):
        scale_probe = _editor_scale_probe(binary, provider)
        scale = [
            {
                "id": "scale-eight-workspaces-sixteen-agents-nine-editors",
                "requirement": "8 Workspaces; 16 live Agents across >=4 Workspaces; 9 Editor WebViews",
                **scale_probe,
            },
            {
                "id": "hidden-editor-continuity",
                "requirement": "Hide >=5 Editor WebViews for 10 minutes; verify identity, Bridge, and dirty-state continuity",
                "status": "covered" if scale_probe.get("hidden_continuity") == "verified" else "blocked",
                "reason": "real ten-minute hidden EditorHost continuity completed" if scale_probe.get("hidden_continuity") == "verified" else "ten-minute hidden-surface continuity not verified",
                "observed_editor_webviews": scale_probe.get("observed_editor_webviews", 0),
                "observed_hidden_surfaces": scale_probe.get("observed_hidden_surfaces", 0),
                "observed_hidden_minutes": scale_probe.get("observed_hidden_minutes", 0),
                "hidden_duration_seconds": scale_probe.get("hidden_duration_seconds"),
                "hidden_continuity": scale_probe.get("hidden_continuity", "not_executed"),
                "checks": scale_probe.get("hidden_checks", {}),
                "owner_continuity": scale_probe.get(
                    "hidden_owner_continuity", "not_observed"
                ),
                "continuity_fact": scale_probe.get("hidden_continuity_fact"),
            },
            {
                "id": "interactive-native-input",
                "requirement": "Verify post-return keyboard input in the visible Editor Surface",
                "status": "deferred",
                "reason": "user_interaction_environment_deferred",
            },
        ]
        lifecycle = [
            {
                "id": "window-reconstruction-10x",
                "requirement": "Window reconstruction x10",
                "status": "deferred",
                "reason": "user_interaction_environment_deferred",
            },
            {
                "id": "quit-relaunch-5x",
                "requirement": "Quit/relaunch x5 with >=2 Agents and >=2 live Workspace tmux sessions",
                **_q5_quit_relaunch_matrix(binary, provider),
            },
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
                "Hide >=5 Editor WebViews for 10 minutes; verify identity, Bridge, and dirty-state continuity",
                native_reason,
            ),
            {
                "id": "interactive-native-input",
                "requirement": "Verify post-return keyboard input in the visible Editor Surface",
                "status": "deferred",
                "reason": "user_interaction_environment_deferred",
            },
        ]
        lifecycle = [
            {
                "id": "window-reconstruction-10x",
                "requirement": "Window reconstruction x10",
                "status": "deferred",
                "reason": "user_interaction_environment_deferred",
            },
            _matrix_entry(
                "quit-relaunch-5x",
                "Quit/relaunch x5 with >=2 Agents and >=2 live Workspace tmux sessions",
                native_reason,
            ),
        ]
    crashes = [
        _matrix_entry(
            "managed-editor-provider",
            "Crash managed editor provider; verify isolation and recovery",
            "managed editor-provider crash probe not executed.",
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
    if (
        run_interactive
        and not only_scale
        and binary_available
        and provider_available
        and provider_consent_ready
        and gui_available
        and native_boundary_available
    ):
        crashes[0] = {
            "id": "managed-editor-provider",
            "requirement": f"Crash managed {provider_kind} provider; verify isolation and recovery",
            **_managed_provider_crash_attempt(binary, provider, input_driver),
        }
    if provider_checks.get("herdr_real_runtime", {}).get("status") == "pass":
        crashes[1].update({"status": "covered", "isolation_verified": True, "recovery_verified": True})
    if provider_checks.get("tmux_transition_matrix", {}).get("status") == "pass" and provider_checks.get(
        "tmux_pty_continuity", {}
    ).get("status") == "pass":
        crashes[2].update({"status": "covered", "isolation_verified": True, "recovery_verified": True})

    if input_driver is not None:
        input_driver.close()

    if isinstance(provider, OfficialVSCodeArtifact):
        provider_evidence = {
            "kind": "official-vscode",
            "status": "selected",
            "version": provider.version,
            "commit": provider.commit,
            "architecture": provider.architecture,
            "license_consent": "explicit" if provider.license_accepted else "not_set",
        }
    elif isinstance(provider, OpenVSCodeArtifact):
        provider_evidence = {
            "kind": "openvscode",
            "status": "legacy-selected",
            "version": OPENVSCODE_VERSION,
            "commit": OPENVSCODE_COMMIT,
            "license_consent": "provider-default",
        }
    else:
        provider_evidence = {
            "kind": "official-vscode",
            "status": "unavailable",
            "version": "unknown",
            "commit": "unknown",
            "license_consent": "not_set",
        }

    report = {
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
        "provider": provider_evidence,
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
    return report


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
        status = entry.get("status")
        if status not in {"blocked", "measured"}:
            raise NativeReportError(f"timing status invalid: {timing_id}")
        if not isinstance(samples, list) or len(samples) not in (0, MEASURED_RUNS):
            raise NativeReportError(f"timing sample count invalid: {timing_id}")
        if any(
            not isinstance(sample, (int, float))
            or isinstance(sample, bool)
            or not math.isfinite(sample)
            or sample < 0
            for sample in samples
        ):
            raise NativeReportError(f"timing sample invalid: {timing_id}")
        if status == "blocked" and (samples or entry.get("p95_ms") is not None):
            raise NativeReportError(f"blocked timing retained measurements: {timing_id}")
        if status == "measured" and len(samples) != MEASURED_RUNS:
            raise NativeReportError(f"measured timing is incomplete: {timing_id}")
        if samples and entry.get("p95_ms") != nearest_rank_p95(samples):
            raise NativeReportError(f"timing p95 missing or incorrect: {timing_id}")
        if samples and (
            nearest_rank_p95(samples) > TIMING_BUDGET_MS[timing_id]
            or any(sample > TIMING_BUDGET_MS[timing_id] for sample in samples)
        ):
            raise NativeReportError(f"timing budget exceeded: {timing_id}")
    scale = report.get("scale_endurance")
    if not isinstance(scale, list) or not all(isinstance(entry, Mapping) for entry in scale) or [entry.get("id") for entry in scale] != [
        "scale-eight-workspaces-sixteen-agents-nine-editors",
        "hidden-editor-continuity",
        "interactive-native-input",
    ]:
        raise NativeReportError("native scale matrix drifted")
    lifecycle = report.get("lifecycle")
    if not isinstance(lifecycle, list) or not all(isinstance(entry, Mapping) for entry in lifecycle) or [entry.get("id") for entry in lifecycle] != [
        "window-reconstruction-10x",
        "quit-relaunch-5x",
    ]:
        raise NativeReportError("native lifecycle matrix drifted")
    provider = report.get("provider")
    if provider is not None:
        if not isinstance(provider, Mapping) or provider.get("kind") not in {
            "official-vscode",
            "openvscode",
        }:
            raise NativeReportError("native provider identity missing")
        if provider.get("kind") == "official-vscode" and provider.get("status") == "selected":
            version = provider.get("version")
            commit = provider.get("commit")
            if (
                not isinstance(version, str)
                or version.count(".") != 2
                or not all(component.isdigit() for component in version.split("."))
                or not isinstance(commit, str)
                or len(commit) != 40
            ):
                raise NativeReportError("official provider release identity missing")
    # A matrix is evidence-bearing only when its exact requirement and
    # verification facts are present.  In particular, no caller can turn a
    # validator-only placeholder into a pass by changing one status field.
    for entry in [*scale, *lifecycle]:
        if not isinstance(entry, Mapping) or not isinstance(entry.get("requirement"), str):
            raise NativeReportError("native matrix requirement missing")
        if entry.get("status") not in {"blocked", "covered", "deferred"}:
            raise NativeReportError("native matrix status vocabulary drifted")
        if entry.get("id") == "interactive-native-input" and (
            entry.get("status") != "deferred"
            or entry.get("reason") != "user_interaction_environment_deferred"
        ):
            raise NativeReportError("interactive native input must remain explicitly deferred")
        if entry.get("id") == "window-reconstruction-10x" and (
            entry.get("status") != "deferred"
            or entry.get("reason") != "user_interaction_environment_deferred"
        ):
            raise NativeReportError("interactive window reconstruction must remain explicitly deferred")
        if entry.get("status") == "covered":
            if entry.get("id") == "scale-eight-workspaces-sixteen-agents-nine-editors":
                if not isinstance(provider, Mapping) or provider.get("kind") != "official-vscode":
                    raise NativeReportError("legacy editor provider cannot claim primary scale evidence")
                distribution = entry.get("workspace_agent_counts")
                if (
                    entry.get("observed_editor_webviews") != 9
                    or entry.get("workspace_count") != 8
                    or entry.get("agent_count") != 16
                    or not isinstance(distribution, list)
                    or len(distribution) != 8
                    or sum(value for value in distribution if isinstance(value, int)) != 16
                    or sum(value > 0 for value in distribution if isinstance(value, int)) < 4
                    or not isinstance(entry.get("provider_pids"), list)
                    or not isinstance(entry.get("bridge_generations"), list)
                    or len(entry.get("bridge_generations")) < 9
                    or any(
                        not isinstance(generation, int) or generation <= 0
                        for generation in entry.get("bridge_generations")
                    )
                    or entry.get("cleanup_status") != "passed"
                ):
                    raise NativeReportError("scale matrix claimed without exact live counts")
            elif entry.get("id") == "hidden-editor-continuity":
                continuity = entry.get("continuity_fact")
                hidden_duration = entry.get("hidden_duration_seconds")
                hidden_surfaces = entry.get("observed_hidden_surfaces")
                hidden_minutes = entry.get("observed_hidden_minutes")
                if (
                    entry.get("hidden_continuity") != "verified"
                    or not isinstance(hidden_duration, (int, float))
                    or isinstance(hidden_duration, bool)
                    or not math.isfinite(hidden_duration)
                    or hidden_duration < 600
                    or not isinstance(hidden_surfaces, int)
                    or isinstance(hidden_surfaces, bool)
                    or hidden_surfaces < 5
                    or not isinstance(hidden_minutes, (int, float))
                    or isinstance(hidden_minutes, bool)
                    or not math.isfinite(hidden_minutes)
                    or hidden_minutes < 10
                    or entry.get("checks")
                    != {
                        "load_identity": "pass",
                        "bridge_connection": "pass",
                        "dirty_state": "pass",
                    }
                    or entry.get("owner_continuity") != "verified"
                    or not isinstance(continuity, Mapping)
                    or not isinstance(continuity.get("baseline_count"), int)
                    or isinstance(continuity.get("baseline_count"), bool)
                    or continuity.get("baseline_count") < 9
                    or not isinstance(continuity.get("current_count"), int)
                    or isinstance(continuity.get("current_count"), bool)
                    or continuity.get("current_count") < 9
                    or not isinstance(continuity.get("hidden_count"), int)
                    or isinstance(continuity.get("hidden_count"), bool)
                    or continuity.get("hidden_count") < 5
                    or not isinstance(continuity.get("duration_ms"), int)
                    or isinstance(continuity.get("duration_ms"), bool)
                    or continuity.get("duration_ms") < 600_000
                    or round(continuity.get("duration_ms", 0) / 1000.0, 3)
                    != hidden_duration
                    or round(hidden_duration / 60.0, 3) != hidden_minutes
                    or any(
                        continuity.get(name) != 0
                        for name in (
                            "missing_count",
                            "disconnected_count",
                            "generation_mismatch_count",
                            "context_mismatch_count",
                            "dirty_mismatch_count",
                        )
                    )
                    or continuity.get("owner_missing_count") != 0
                    or continuity.get("owner_lookup_result") != "ok"
                    or continuity.get("owner_lookup_error_code") != "none"
                    or continuity.get("active_editor") != "workspace"
                    or continuity.get("continuity") != "pass"
                ):
                    raise NativeReportError("hidden continuity claimed without verified evidence")
            elif entry.get("id") == "quit-relaunch-5x":
                cycle_facts = entry.get("cycle_facts")
                agents_retained = entry.get("agents_retained")
                tmux_retained = entry.get("tmux_sessions_retained")
                if (
                    entry.get("cycles_completed") != 5
                    or not isinstance(agents_retained, int)
                    or isinstance(agents_retained, bool)
                    or agents_retained < 2
                    or not isinstance(tmux_retained, int)
                    or isinstance(tmux_retained, bool)
                    or tmux_retained < 2
                    or not isinstance(entry.get("app_pids"), list)
                    or len(entry.get("app_pids")) != 5
                    or entry.get("navigation_restored") is not True
                    or entry.get("editor_port_available_after_quit") != [True] * 5
                    or entry.get("retained_editor_process_counts") != [0] * 5
                    or not isinstance(cycle_facts, list)
                    or len(cycle_facts) != 5
                    or any(
                        not isinstance(fact, Mapping)
                        or fact.get("cycle") != index
                        or fact.get("quit_outcome") not in {"sent", "already_terminated"}
                        or fact.get("shutdown_clean") is not True
                        or fact.get("port_available_after_quit") is not True
                        or fact.get("selected_provider_port_file") != "official"
                        or fact.get("port_release_category") != "released"
                        or fact.get("listener_count_after_quit") != 0
                        or fact.get("listener_owned_by_fixture") is not False
                        or fact.get("retained_editor_process_count") != 0
                        or fact.get("navigation_restored") is not True
                        or fact.get("workspace_count") != 8
                        or fact.get("agent_count") != 16
                        or fact.get("mapping_count") != 16
                        or fact.get("bridge_surface_count") != 9
                        or fact.get("bridge_identity_ready") is not True
                        or fact.get("bridge_generation_ready") is not True
                        or fact.get("bridge_connection_ready") is not True
                        or not isinstance(fact.get("agents_retained"), int)
                        or fact.get("agents_retained") < 2
                        or not isinstance(fact.get("tmux_sessions_retained"), int)
                        or fact.get("tmux_sessions_retained") < 2
                        or fact.get("state_restored") is not True
                        for index, fact in enumerate(cycle_facts, start=1)
                    )
                    or entry.get("cleanup_status") != "passed"
                ):
                    raise NativeReportError("relaunch matrix claimed without retained provider counts")
    redaction = report.get("redaction")
    required_redactions = {
        "machine_identifiers": "omitted",
        "absolute_paths": "omitted",
        "unbounded_process_output": "omitted",
    }
    if not isinstance(redaction, Mapping) or any(
        redaction.get(name) != value for name, value in required_redactions.items()
    ):
        raise NativeReportError("required redaction declarations are missing")
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


def _self_test_owned_herdr_stop() -> None:
    """Prove exact-socket ownership without relying on Herdr argv contents."""

    with tempfile.TemporaryDirectory(prefix="q5-hs-", dir="/tmp") as raw:
        home = Path(raw).resolve()
        socket_path = _q5_herdr_socket(home)
        socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        received: list[dict[str, Any]] = []
        ready = threading.Event()

        def serve() -> None:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(socket_path))
                listener.listen(1)
                ready.set()
                connection, _ = listener.accept()
                with connection:
                    data = bytearray()
                    while not data.endswith(b"\n"):
                        chunk = connection.recv(4096)
                        if not chunk:
                            return
                        data.extend(chunk)
                    received.append(json.loads(data))
                    connection.sendall(b'{"result":{"stopped":true}}\n')
                socket_path.unlink(missing_ok=True)

        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        if not ready.wait(timeout=2) or not _stop_owned_herdr(home):
            raise NativeReportError("owned Herdr socket stop self-test failed")
        worker.join(timeout=2)
        if worker.is_alive() or len(received) != 1:
            raise NativeReportError("owned Herdr socket stop was not observed")
        request = received[0]
        if (
            request.get("method") != "server.stop"
            or request.get("params") != {}
            or str(home) in json.dumps(request, sort_keys=True)
            or socket_path.exists()
        ):
            raise NativeReportError("owned Herdr stop crossed the socket ownership boundary")


def _q5_tty_process_count() -> int:
    try:
        result = subprocess.run(
            ["ps", "-axo", "tty="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise NativeReportError("TTY baseline unavailable") from error
    return sum(
        value not in {"", "??", "?", "-"}
        for value in (line.strip() for line in result.stdout.splitlines())
    )


def _self_test_q5_early_return_cleanup() -> None:
    """Prove an early return reaps an exact ledger-owned PTY first."""

    baseline = _q5_tty_process_count()

    def attach_controlling_tty() -> None:
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    def return_early() -> tuple[Path, int]:
        master = -1
        slave = -1
        try:
            with _q5_owned_fixture_home("q5-early-cleanup-") as fixture:
                master, slave = os.openpty()
                env = os.environ.copy()
                env.update(
                    {
                        "DEVHUB_HERDR_TRACE_FILE": str(fixture.home / ".q5-agent-trace"),
                        "DEVHUB_HERDR_PID_DIR": str(fixture.pid_dir),
                    }
                )
                child = subprocess.Popen(
                    [str(fixture.commands / "codex")],
                    env=env,
                    stdin=slave,
                    stdout=slave,
                    stderr=subprocess.DEVNULL,
                    preexec_fn=attach_controlling_tty,
                )
                # Real fixture Agents are children of Herdr. This direct
                # self-test child needs a waiter so a successful ledger TERM
                # is reaped instead of remaining visible as our Python zombie.
                reaper = threading.Thread(target=child.wait, daemon=True)
                reaper.start()
                os.close(slave)
                slave = -1
                deadline = time.monotonic() + 2.0
                while time.monotonic() < deadline and not list(fixture.pid_dir.glob("*.pid")):
                    time.sleep(0.02)
                if child.poll() is not None or not list(fixture.pid_dir.glob("*.pid")):
                    raise NativeReportError("early-return Agent ledger was not live")
                if _q5_tty_process_count() <= baseline:
                    raise NativeReportError("early-return fixture did not allocate its PTY")
                return fixture.home, child.pid
        finally:
            if slave >= 0:
                os.close(slave)
            if master >= 0:
                os.close(master)

    home, pid = return_early()
    if home.exists() or _q5_pid_is_live(pid):
        raise NativeReportError("early-return fixture outlived its ownership handles")
    if _q5_tty_process_count() != baseline:
        raise NativeReportError("early-return fixture did not restore the TTY baseline")


def _self_test_native_input_poisoning() -> None:
    """Prove a timed-out actor cannot consume a later stale response frame."""

    class FakePipe:
        def write(self, _value: str) -> None:
            pass

        def flush(self) -> None:
            pass

        def close(self) -> None:
            pass

    class FakeProcess:
        def __init__(self) -> None:
            self.stdin = FakePipe()
            self.stdout = object()
            self.killed = False

        def poll(self) -> None:
            return None

        def kill(self) -> None:
            self.killed = True

        def wait(self, timeout: float) -> int:
            return 0

    actor = _NativeInput(Path("/private/tmp/q52-native-input-self-test"))
    process = FakeProcess()
    actor._process = process  # type: ignore[assignment]
    observed_timeouts: list[float] = []
    original_select = select.select
    try:
        def no_response(_readers: object, _writers: object, _errors: object, timeout: float):
            observed_timeouts.append(timeout)
            return [], [], []

        select.select = no_response  # type: ignore[assignment]
        if actor.invoke("activate-pid", "1") is not None:
            raise NativeReportError("timed-out native input command unexpectedly succeeded")
        if actor._process is not None or not actor._invalidated or not process.killed:
            raise NativeReportError("timed-out native input actor was not poisoned")
        # A response left in the old actor's pipe must not be consumed by a
        # later command after the timeout has invalidated that actor.
        if actor.invoke("press-enter") is not None:
            raise NativeReportError("poisoned native input actor reused a stale frame")
    finally:
        select.select = original_select  # type: ignore[assignment]
        actor.close()
    if observed_timeouts != [3.0]:
        raise NativeReportError("activate-pid did not use its extended response timeout")


def _self_test_performance_marker_channels() -> None:
    """Keep untimestamped Q5 facts single-sourced with a safe fallback."""

    with tempfile.TemporaryDirectory(prefix="q5-marker-channels-", dir="/tmp") as raw:
        home = Path(raw)
        log_file = home / "Library" / "Logs" / "DevHub" / "devhub.jsonl"
        log_file.parent.mkdir(parents=True)

        complete = [
            "q5_fixture_started",
            "q5_fixture_workspace_ready",
            "q5_fixture_agent_ready",
        ]
        log_file.write_text(
            "".join(
                json.dumps({"event": "performance", "marker": marker}) + "\n"
                for marker in complete
            ),
            encoding="utf-8",
        )
        marker_file = home / ".q5-markers"
        marker_file.write_text("\n".join(complete) + "\n", encoding="utf-8")
        if _performance_markers(log_file) != complete:
            raise NativeReportError("duplicate marker channels were merged")

        marker_file.unlink()
        if _performance_markers(log_file) != complete:
            raise NativeReportError("diagnostics-only marker fallback was not retained")

        partial = complete[:1]
        log_file.write_text(
            "".join(
                json.dumps({"event": "performance", "marker": marker}) + "\n"
                for marker in partial
            ),
            encoding="utf-8",
        )
        marker_file.write_text("\n".join(complete) + "\n", encoding="utf-8")
        if _performance_markers(log_file) != complete:
            raise NativeReportError("complete marker file did not own the Q5 sequence")


def self_test() -> None:
    driver_source = Path(__file__).read_text(encoding="utf-8")
    running_app_source = driver_source.split("def _running_app(", 1)[1].split(
        "def _cleanup_owned_tmux", 1
    )[0]
    if (
        "_q5_owned_fixture_home" not in running_app_source
        or "TemporaryDirectory" in running_app_source
        or "ignore_cleanup_errors" in running_app_source
        or "/private/tmp" in running_app_source
    ):
        raise NativeReportError("running app escaped the secure Q5 owner")
    if any(
        token in driver_source
        for token in (
            "DEVHUB_Q5_" + "MINIMAL_INPUT",
            "q5-minimal-" + "after-open.png",
            "q5-minimal-" + "after-edit.png",
            "debug_" + "minimal_input",
        )
    ):
        raise NativeReportError("temporary interactive diagnostic route survived deferral")
    if not _q5_input_helper_contract():
        raise NativeReportError("native input helper filename/keycode contract drifted")
    if not _q5_process_quit_helper_contract():
        raise NativeReportError("process-only Quit helper contract drifted")
    _self_test_native_quit_contract()
    if not _q5_raw_preflight_cleanup_contract():
        raise NativeReportError("raw Herdr preflight cleanup contract drifted")
    if not _q5_scale_subprocess_home_contract(driver_source):
        raise NativeReportError("scale subprocess escaped the secure Q5 HOME owner")
    _self_test_performance_marker_channels()
    for unsafe_source, shell in (
        ('home = tempfile.TemporaryDirectory(dir="/tmp")', False),
        ('home = tempfile.mkdtemp(dir="/private/tmp")', False),
        ('TemporaryDirectory(ignore_cleanup_errors=True)', False),
        ('ROOT=$(mktemp -d /tmp/dh-real.XXXXXX)', True),
        ('ROOT=$(mktemp -d "$TMPDIR/dh-real.XXXXXX")', True),
        ('ROOT=$(mktemp -d)', True),
    ):
        if _scale_home_source_is_secure(unsafe_source, shell=shell):
            raise NativeReportError("insecure scale HOME allocator passed static policy")
    with tempfile.TemporaryDirectory(prefix="q5-dispatch-fact-", dir="/tmp") as raw:
        diagnostic_home = Path(raw)
        marker_file = diagnostic_home / ".q5-markers"
        marker_file.write_text(
            "fact=q5_dispatch_failure index=14 stage=agent_start effect=launch_agent "
            "app_error_code=native_unavailable port_error_code=failed "
            "agent_runtime_error_code=provider_rejected "
            "provider_error_category=agent_pane_busy workspace_count=8 completed_agents=14\n",
            encoding="utf-8",
        )
        parsed = _q5_dispatch_diagnostics(diagnostic_home)
        if parsed != [
            {
                "index": 14,
                "stage": "agent_start",
                "effect": "launch_agent",
                "app_error_code": "native_unavailable",
                "port_error_code": "failed",
                "agent_runtime_error_code": "provider_rejected",
                "provider_error_category": "agent_pane_busy",
                "workspace_count": 8,
                "completed_agents": 14,
            }
        ]:
            raise NativeReportError("closed provider error category was not retained")
        marker_file.write_text(
            marker_file.read_text(encoding="utf-8").replace(
                "provider_error_category=agent_pane_busy",
                "provider_error_category=private_provider_text",
            ),
            encoding="utf-8",
        )
        if _q5_dispatch_diagnostics(diagnostic_home):
            raise NativeReportError("unbounded provider error category was retained")
        marker_file.write_text(
            "fact=q5_startup_reconstruction stage=workspace_surface status=failed "
            "error_code=readiness_timeout\n",
            encoding="utf-8",
        )
        if _q5_reconstruction_diagnostics(diagnostic_home) != [
            {
                "stage": "workspace_surface",
                "status": "failed",
                "error_code": "readiness_timeout",
            }
        ]:
            raise NativeReportError("closed reconstruction diagnostic was not retained")
        marker_file.write_text(
            "fact=q5_startup_reconstruction stage=workspace_surface status=failed "
            "error_code=private_provider_text\n",
            encoding="utf-8",
        )
        if _q5_reconstruction_diagnostics(diagnostic_home):
            raise NativeReportError("unbounded reconstruction diagnostic was retained")
        marker_file.write_text(
            "fact=q5_relaunch_state workspace_count=8 agent_count=16 mapping_count=16 "
            "surface_count=9 missing_identity_count=0 duplicate_identity_count=0 "
            "disconnected_count=0 not_ready_count=0 generation_zero_count=0 "
            "context_mismatch_count=0 active_editor=workspace status=pass\n",
            encoding="utf-8",
        )
        if _q5_relaunch_state_facts(diagnostic_home) != [
            {
                "workspace_count": 8,
                "agent_count": 16,
                "mapping_count": 16,
                "surface_count": 9,
                "missing_identity_count": 0,
                "duplicate_identity_count": 0,
                "disconnected_count": 0,
                "not_ready_count": 0,
                "generation_zero_count": 0,
                "context_mismatch_count": 0,
                "active_editor": "workspace",
                "status": "pass",
            }
        ]:
            raise NativeReportError("exact relaunch fact was not retained")
        state_path = (
            diagnostic_home
            / "Library"
            / "Application Support"
            / "DevHub"
            / "state.json"
        )
        state_path.parent.mkdir(parents=True)
        state_path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "shutdown": {"clean": True},
                    "workspaces": [
                        {
                            "workspace_id": "private-workspace-id",
                            "canonical_path": "/private/path",
                            "agents": [
                                {
                                    "agent_id": "private-agent-id",
                                    "provider_mapping": {"value": "private-provider-id"},
                                },
                                {"agent_id": "private-agent-id-2", "provider_mapping": None},
                            ],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        state_shape = _q5_state_shape(diagnostic_home)
        if state_shape != {
            "status": "present",
            "schema_version": 1,
            "workspace_count": 1,
            "agent_count": 2,
            "provider_mapping_count": 1,
            "shutdown_clean": True,
        } or "private" in json.dumps(state_shape, sort_keys=True):
            raise NativeReportError("state shape diagnostic crossed the redaction boundary")
        port_file = (
            diagnostic_home
            / "Library"
            / "Application Support"
            / "DevHub"
            / "VisualStudioCode"
            / "port"
        )
        port_file.parent.mkdir(parents=True)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            port_file.write_text(f"{listener.getsockname()[1]}\n", encoding="utf-8")
            if _q5_editor_port_available(diagnostic_home) is not False:
                raise NativeReportError("occupied editor origin was reported available")
        if _q5_editor_port_available(diagnostic_home) is not True:
            raise NativeReportError("released editor origin was reported occupied")

        delayed_listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        delayed_listener.bind(("127.0.0.1", 0))
        port_file.write_text(f"{delayed_listener.getsockname()[1]}\n", encoding="utf-8")
        release = threading.Thread(
            target=lambda: (time.sleep(0.05), delayed_listener.close()), daemon=True
        )
        release.start()
        released = _q5_wait_editor_port_release(
            diagnostic_home, None, (), budget_seconds=0.5
        )
        release.join(timeout=1)
        if (
            released["available"] is not True
            or released["category"] != "released"
            or released["listener_count"] != 0
        ):
            raise NativeReportError("delayed editor port release did not reach quiescence")

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as persistent_listener:
            persistent_listener.bind(("127.0.0.1", 0))
            port_file.write_text(
                f"{persistent_listener.getsockname()[1]}\n", encoding="utf-8"
            )
            persisted = _q5_wait_editor_port_release(
                diagnostic_home, None, (), budget_seconds=0.05
            )
            if persisted["available"] is not False or persisted["category"] == "released":
                raise NativeReportError("persistent editor listener passed quiescence")

        stale_home = diagnostic_home / "stale-provider"
        legacy_port = (
            stale_home
            / "Library"
            / "Application Support"
            / "DevHub"
            / "OpenVSCode"
            / "port"
        )
        legacy_port.parent.mkdir(parents=True)
        legacy_port.write_text("54945\n", encoding="utf-8")
        official = OfficialVSCodeArtifact(
            Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
            "test",
            "test",
            "arm64",
            "self_test",
            True,
        )
        if _q5_editor_port_probe(stale_home, official)[
            "selected_provider_port_file"
        ] != "missing":
            raise NativeReportError("stale legacy provider port was selected for official VS Code")
    fixture_failure_cases = {
        ("q5_fixture_agent_dispatch_failed",): "q5_fixture_agent_dispatch_failed",
        ("q5_fixture_start_failed",): "startup_reconstruction_failed",
        ("q5_fixture_start_skipped",): "startup_reconstruction_not_ready",
        ("q5_fixture_workspace_ready",): None,
    }
    for markers, expected_reason in fixture_failure_cases.items():
        if _q5_fixture_terminal_failure(markers) != expected_reason:
            raise NativeReportError("terminal fixture marker did not end its waiter exactly")
    stale_lifecycle_markers = (
        "q5_fixture_scale_ready",
        "q5_fixture_agent_dispatch_failed",
    )
    if _q5_marker_advanced(stale_lifecycle_markers, "q5_fixture_scale_ready", 1):
        raise NativeReportError("relaunch reused a stale scale-ready marker")
    if not _q5_marker_advanced(
        (*stale_lifecycle_markers, "q5_fixture_scale_ready"),
        "q5_fixture_scale_ready",
        1,
    ):
        raise NativeReportError("relaunch ignored a fresh scale-ready marker")
    prior_failures = {"q5_fixture_agent_dispatch_failed": 1}
    if _q5_fixture_terminal_failure_after(stale_lifecycle_markers, prior_failures) is not None:
        raise NativeReportError("relaunch reused a stale terminal failure marker")
    if (
        _q5_fixture_terminal_failure_after(
            (*stale_lifecycle_markers, "q5_fixture_agent_dispatch_failed"), prior_failures
        )
        != "q5_fixture_agent_dispatch_failed"
    ):
        raise NativeReportError("relaunch ignored a fresh terminal failure marker")
    _self_test_native_input_poisoning()
    _self_test_owned_herdr_stop()
    _self_test_q5_early_return_cleanup()
    if _execution_boundary({"CODEX_SANDBOX": "seatbelt"})["reason"] != "native_execution_boundary_unavailable":
        raise NativeReportError("sandbox boundary preflight failed")
    if _execution_boundary({})["reason"] != "native_execution_boundary_available":
        raise NativeReportError("native boundary preflight failed")
    resource_artifact = OpenVSCodeArtifact(
        Path("/private/tmp/q52-resource"), Path("/private/tmp/q52-resource"), "self_test"
    )
    resource_environment = _provider_environment({}, resource_artifact)
    if (
        resource_environment.get(APP_RESOURCE_ENV) != str(ROOT)
        or resource_environment.get(OPENVSCODE_RESOURCE_ENV) != "/private/tmp/q52-resource"
        or "DEVHUB_RESOURCE_DIR" in resource_environment
        or "DEVHUB_OPENVSCODE_EXECUTABLE" in resource_environment
    ):
        raise NativeReportError("verified resource root was not propagated")
    executable_artifact = OpenVSCodeArtifact(Path("/private/tmp/q52-server"), None, "self_test")
    executable_environment = _provider_environment({}, executable_artifact)
    if (
        executable_environment.get(APP_RESOURCE_ENV) != str(ROOT)
        or executable_environment.get("DEVHUB_OPENVSCODE_EXECUTABLE") != "/private/tmp/q52-server"
        or OPENVSCODE_RESOURCE_ENV in executable_environment
    ):
        raise NativeReportError("standalone executable override was not propagated")
    official_artifact = OfficialVSCodeArtifact(
        Path("/private/tmp/code"),
        "1.134.0",
        "110a328ea54b42367b803ec53ee0bf52ef26b419",
        "arm64",
        "self_test",
    )
    official_environment = _provider_environment({}, official_artifact)
    if (
        official_environment.get("DEVHUB_EDITOR_PROVIDER") != "official-vscode"
        or official_environment.get(APP_RESOURCE_ENV) != str(ROOT)
        or OPENVSCODE_RESOURCE_ENV in official_environment
        or OFFICIAL_VSCODE_LICENSE_ENV in official_environment
    ):
        raise NativeReportError("official provider consent was enabled implicitly")
    consented_environment = _provider_environment(
        {}, replace(official_artifact, license_accepted=True)
    )
    if consented_environment.get(OFFICIAL_VSCODE_LICENSE_ENV) != "1":
        raise NativeReportError("explicit official provider consent was not propagated")
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
    original_input_builder = _NativeInput.__dict__["build"]
    try:
        def reject_automated_input(_cls: type[_NativeInput]) -> None:
            raise NativeReportError("process-only execution compiled native input")

        _NativeInput.build = classmethod(reject_automated_input)  # type: ignore[method-assign]
        report = execute(host, None, run_providers=False, only_scale=True)
        execute(host, None, run_providers=False)
    finally:
        _NativeInput.build = original_input_builder  # type: ignore[method-assign]
    validate_report(report)
    interactive = report["scale_endurance"][2]
    if interactive != {
        "id": "interactive-native-input",
        "requirement": "Verify post-return keyboard input in the visible Editor Surface",
        "status": "deferred",
        "reason": "user_interaction_environment_deferred",
    }:
        raise NativeReportError("interactive native input deferral drifted")

    def assert_rejected(candidate: Mapping[str, Any], label: str) -> None:
        try:
            validate_report(candidate)
        except NativeReportError:
            return
        raise NativeReportError(f"self-test accepted invalid {label}")

    hidden_process_only = json.loads(json.dumps(report))
    hidden_process_only["scale_endurance"][1].update(
        {
            "status": "covered",
            "hidden_continuity": "verified",
            "hidden_duration_seconds": 600.0,
            "observed_hidden_surfaces": 5,
            "observed_hidden_minutes": 10.0,
            "checks": {
                "load_identity": "pass",
                "bridge_connection": "pass",
                "dirty_state": "pass",
            },
            "owner_continuity": "verified",
            "continuity_fact": {
                "baseline_count": 9,
                "current_count": 9,
                "hidden_count": 5,
                "duration_ms": 600_000,
                "missing_count": 0,
                "disconnected_count": 0,
                "generation_mismatch_count": 0,
                "context_mismatch_count": 0,
                "dirty_mismatch_count": 0,
                "owner_missing_count": 0,
                "owner_lookup_result": "ok",
                "owner_lookup_error_code": "none",
                "active_editor": "workspace",
                "continuity": "pass",
            },
        }
    )
    validate_report(hidden_process_only)
    for label, mutation in (
        ("hidden surface count", lambda entry: entry.update(observed_hidden_surfaces=4)),
        ("hidden duration", lambda entry: entry.update(hidden_duration_seconds=599.999)),
        ("hidden identity", lambda entry: entry["checks"].update(load_identity="fail")),
        ("hidden Bridge", lambda entry: entry["checks"].update(bridge_connection="fail")),
        ("hidden dirty state", lambda entry: entry["checks"].update(dirty_state="fail")),
        (
            "hidden owner inventory",
            lambda entry: entry["continuity_fact"].update(owner_missing_count=1),
        ),
        (
            "hidden owner lookup",
            lambda entry: entry["continuity_fact"].update(
                owner_lookup_result="error",
                owner_lookup_error_code="surface_inventory_mismatch",
            ),
        ),
    ):
        candidate = json.loads(json.dumps(hidden_process_only))
        mutation(candidate["scale_endurance"][1])
        assert_rejected(candidate, label)

    interactive_covered = json.loads(json.dumps(hidden_process_only))
    interactive_covered["scale_endurance"][2]["status"] = "covered"
    assert_rejected(interactive_covered, "interactive native input coverage")

    valid_timing = json.loads(json.dumps(report))
    timing = valid_timing["timing_runs"]["process_cold_shell"]
    timing.update(status="measured", samples_ms=[100.0] * MEASURED_RUNS, p95_ms=100.0)
    validate_report(valid_timing)
    invalid_status = json.loads(json.dumps(valid_timing))
    invalid_status["timing_runs"]["process_cold_shell"]["status"] = "pass"
    assert_rejected(invalid_status, "timing status")
    over_budget = json.loads(json.dumps(valid_timing))
    samples = [TIMING_BUDGET_MS["process_cold_shell"] + 1.0] * MEASURED_RUNS
    over_budget["timing_runs"]["process_cold_shell"].update(
        samples_ms=samples, p95_ms=nearest_rank_p95(samples)
    )
    assert_rejected(over_budget, "timing budget")
    incomplete_timing = json.loads(json.dumps(report))
    incomplete_timing["timing_runs"]["process_cold_shell"]["samples_ms"] = [1.0] * 9
    assert_rejected(incomplete_timing, "timing sample count")

    relaunch = json.loads(json.dumps(report))
    cycle_facts = [
        {
            "cycle": cycle,
            "quit_outcome": "sent",
            "shutdown_clean": True,
            "port_available_after_quit": True,
            "selected_provider_port_file": "official",
            "port_release_category": "released",
            "listener_count_after_quit": 0,
            "listener_owned_by_fixture": False,
            "retained_editor_process_count": 0,
            "navigation_restored": True,
            "workspace_count": 8,
            "agent_count": 16,
            "mapping_count": 16,
            "bridge_surface_count": 9,
            "bridge_identity_ready": True,
            "bridge_generation_ready": True,
            "bridge_connection_ready": True,
            "agents_retained": 16,
            "tmux_sessions_retained": 2,
            "state_restored": True,
        }
        for cycle in range(1, 6)
    ]
    relaunch["lifecycle"][1].update(
        status="covered",
        cycles_required=5,
        cycles_completed=5,
        agents_retained=16,
        tmux_sessions_retained=2,
        navigation_restored=True,
        app_pids=[1, 2, 3, 4, 5],
        editor_port_available_after_quit=[True] * 5,
        retained_editor_process_counts=[0] * 5,
        cycle_facts=cycle_facts,
        cleanup_status="passed",
    )
    validate_report(relaunch)
    relaunch_failures = (
        ("relaunch quit outcome", "quit_outcome", "request_rejected"),
        ("relaunch shutdown clean", "shutdown_clean", False),
        ("relaunch port", "port_available_after_quit", False),
        ("relaunch provider port file", "selected_provider_port_file", "legacy"),
        ("relaunch port release", "port_release_category", "listener_persisted"),
        ("relaunch listener count", "listener_count_after_quit", 1),
        ("relaunch listener ownership", "listener_owned_by_fixture", True),
        ("relaunch residual", "retained_editor_process_count", 1),
        ("relaunch navigation", "navigation_restored", False),
        ("relaunch Bridge identity", "bridge_identity_ready", False),
        ("relaunch Bridge generation", "bridge_generation_ready", False),
        ("relaunch Bridge readiness", "bridge_connection_ready", False),
        ("relaunch state", "state_restored", False),
        ("relaunch Agent retention", "agents_retained", 1),
        ("relaunch tmux retention", "tmux_sessions_retained", 1),
    )
    for label, key, value in relaunch_failures:
        candidate = json.loads(json.dumps(relaunch))
        candidate["lifecycle"][1]["cycle_facts"][2][key] = value
        assert_rejected(candidate, label)

    for declaration in (
        "machine_identifiers",
        "absolute_paths",
        "unbounded_process_output",
    ):
        candidate = json.loads(json.dumps(report))
        del candidate["redaction"][declaration]
        assert_rejected(candidate, f"redaction declaration {declaration}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true", help="probe host/artifacts and write a report")
    mode.add_argument("--execute", action="store_true", help="run real app/provider attempts")
    mode.add_argument("--scale-endurance", action="store_true", help="run only the real scale/endurance gates")
    mode.add_argument("--check", action="store_true", help="validate an existing native report")
    mode.add_argument("--self-test", action="store_true", help="run redaction/count self-tests")
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "evidence" / "q5.2-native-report.json")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--skip-providers", action="store_true", help="do not run real provider checks")
    parser.add_argument(
        "--interactive-manual",
        action="store_true",
        help="run user-attended native screen/input scenarios; never use in automated acceptance",
    )
    parser.add_argument(
        "--accept-official-vscode-license",
        action="store_true",
        help="explicitly consent to the separately installed official VS Code Server license for this run",
    )
    parser.add_argument(
        "--legacy-openvscode-smoke",
        action="store_true",
        help="explicitly select the pinned OpenVSCode provider for a bounded legacy smoke",
    )
    parser.add_argument(
        "--only-scenario",
        choices=TIMING_IDS,
        help="execute one timing scenario (all other entries remain blocked)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.interactive_manual and not args.execute:
            raise NativeReportError("--interactive-manual requires --execute")
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
        host, official_vscode, openvscode = probe_host()
        if args.legacy_openvscode_smoke:
            selected_provider: ProviderArtifact | None = openvscode
        elif official_vscode is not None:
            selected_provider = replace(
                official_vscode,
                license_accepted=args.accept_official_vscode_license,
            )
        else:
            selected_provider = None
        report = execute(
            host,
            selected_provider,
            run_providers=(args.execute or args.scale_endurance) and not args.skip_providers,
            run_interactive=args.interactive_manual,
            only_scenario=args.only_scenario,
            only_scale=args.scale_endurance,
        )
        write_report(args.output, report)
        print(f"Q5.2 native report written: {args.output.name}")
        return 0
    except (NativeReportError, OSError, json.JSONDecodeError) as error:
        print(f"q5.2 native driver: {error}", file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
