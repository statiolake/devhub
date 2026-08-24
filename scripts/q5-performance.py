#!/usr/bin/env python3
"""DevHub Q5.2 performance and endurance acceptance harness.

The native interaction budgets are intentionally represented as data rather
than inferred from unit-test or process-start timings.  A release operator can
record ten raw samples after one untimed setup run with ``--record --input``;
the harness computes the nearest-rank p95, validates the exact scale matrix,
and rejects reports that contain machine identifiers or unredacted paths.

The default report is honest about what can be automated in a headless/local
checkout: native timing and interactive continuity remain ``pending`` until a
reference-Mac run records them.  This script never turns a missing sample into
a passing budget.
"""

from __future__ import annotations

import argparse
import datetime as datetime_module
import json
import math
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = 1
GATE = "Q5.2"
SAMPLE_COUNT = 10
SETUP_COUNT = 1


BUDGETS: tuple[dict[str, Any], ...] = (
    {
        "id": "process_cold_shell",
        "label": "process-cold Shell presentation",
        "budget_ms": 2_000.0,
        "definition": "DevHub and managed OpenVSCode are absent before launch.",
        "interactive": True,
    },
    {
        "id": "scratch_interactive",
        "label": "Scratch interactive response",
        "budget_ms": 3_000.0,
        "definition": "Global Scratch accepts input and produces its local response.",
        "interactive": True,
    },
    {
        "id": "workspace_picker_first_result",
        "label": "Workspace Picker first result",
        "budget_ms": 300.0,
        "definition": "The first result appears while query input remains responsive during scan.",
        "interactive": True,
    },
    {
        "id": "mounted_activity_switch",
        "label": "mounted Activity switch",
        "budget_ms": 100.0,
        "definition": "Switch between already-mounted Activities without provider startup.",
        "interactive": True,
    },
    {
        "id": "cold_openvscode_interactive",
        "label": "cold OpenVSCode interactive response",
        "budget_ms": 10_000.0,
        "definition": "Managed OpenVSCode is absent; the Workbench accepts input.",
        "interactive": True,
    },
    {
        "id": "warm_workbench_reconstruction",
        "label": "warm Workbench reconstruction",
        "budget_ms": 5_000.0,
        "definition": "The provider is warm while the main Window is reconstructed.",
        "interactive": True,
    },
)
TIMING_IDS = tuple(item["id"] for item in BUDGETS)


TMUX_CASES = (
    "absent_target",
    "wrong_marker_conflict",
    "marked_target_conflict",
    "preserved_unknown_sessions",
    "partial_old_cleanup",
    "crash_relaunch_each_transition_state",
    "recreation_failure_after_new_effective_name",
)

CRASH_PROVIDERS = (
    "managed_openvscode",
    "herdr_connection_or_server",
    "owned_tmux_session",
)

FORBIDDEN_KEY_PARTS = (
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
)
ABSOLUTE_PATH = re.compile(r"(?:^|[=:\s])/(?:private/)?(?:Users|home|var|tmp|opt|usr|Applications)/")


class ReportError(ValueError):
    """Raised when a Q5.2 report violates the acceptance contract."""


def p95(samples: Sequence[float]) -> float:
    """Return the nearest-rank p95 used by the acceptance method."""

    if not samples:
        raise ReportError("p95 requires at least one sample")
    ordered = sorted(float(sample) for sample in samples)
    rank = max(1, math.ceil(0.95 * len(ordered)))
    return ordered[rank - 1]


def _version(command: Sequence[str]) -> str:
    executable = shutil.which(command[0])
    if executable is None:
        return "unavailable"
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return "unavailable"
    output = (result.stdout or result.stderr).strip().splitlines()
    if result.returncode != 0 or not output:
        return "unavailable"
    # Keep only the first bounded line.  The command name is recorded
    # separately and the absolute executable path is deliberately discarded.
    return re.sub(r"\s+", " ", output[0])[:160]


def environment() -> dict[str, Any]:
    """Collect release-useful versions without reading ambient identity."""

    return {
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
        "machine_identifiers": "omitted",
        "ambient_paths": "omitted",
    }


def _pending_timing(spec: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "label": spec["label"],
        "budget_ms": spec["budget_ms"],
        "definition": spec["definition"],
        "interactive": spec["interactive"],
        "status": "pending",
        "measurement_kind": "not-measured",
        "setup_runs": 0,
        "measured_runs": 0,
        "samples_ms": [],
        "p95_ms": None,
        "reason": "Requires ten native reference-context interaction samples.",
    }


def template_report() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "gate": GATE,
        "sample_policy": {
            "setup_runs": SETUP_COUNT,
            "measured_runs": SAMPLE_COUNT,
            "percentile": "nearest_rank_p95",
            "raw_samples_preserved": True,
        },
        "environment": environment(),
        "timings": {spec["id"]: _pending_timing(spec) for spec in BUDGETS},
        "scale_endurance": {
            "workspaces": {
                "required": 8,
                "observed": None,
                "status": "pending",
                "evidence": "Native scale run pending.",
            },
            "live_agents": {
                "required": 16,
                "minimum_workspace_distribution": 4,
                "observed": None,
                "observed_workspace_distribution": None,
                "status": "pending",
                "evidence": "Native scale run pending.",
            },
            "editor_webviews": {
                "required": 9,
                "required_identity": "global plus eight Workspace Editors",
                "observed": None,
                "global_present": None,
                "workspace_identity_count": None,
                "status": "pending",
                "evidence": "Native scale run pending.",
            },
            "hidden_surface_continuity": {
                "required_hidden_surfaces": 5,
                "required_hidden_minutes": 10,
                "observed_hidden_surfaces": None,
                "observed_hidden_minutes": None,
                "checks": {
                    "load_identity": "pending",
                    "bridge_connection": "pending",
                    "dirty_state": "pending",
                    "input": "pending",
                },
                "status": "pending",
                "evidence": "Native scale run pending.",
            },
            "window_reconstruction": {
                "required_runs": 10,
                "observed_runs": 0,
                "status": "pending",
                "evidence": "Native lifecycle run pending.",
            },
            "quit_relaunch": {
                "required_runs": 5,
                "observed_runs": 0,
                "minimum_live_agents": 2,
                "minimum_live_workspace_tmux_sessions": 2,
                "survival_checks": {
                    "agents": "pending",
                    "workspace_tmux_sessions": "pending",
                    "navigation": "pending",
                },
                "status": "pending",
                "evidence": "Native lifecycle run pending.",
            },
        },
        "provider_crashes": {
            provider: {
                "status": "pending",
                "isolation_verified": False,
                "recovery_verified": False,
                "evidence": "Independent native crash run pending.",
            }
            for provider in CRASH_PROVIDERS
        },
        "tmux_transition_matrix": {
            "required_cases": list(TMUX_CASES),
            "status": "pending",
            "cases": {case: "pending" for case in TMUX_CASES},
            "evidence": "Run the existing real-tmux transition matrix; no unmarked session may be mutated.",
        },
        "local_checks": [],
        "redaction": {
            "machine_identifiers": "omitted",
            "absolute_paths": "omitted",
            "unbounded_process_output": "omitted",
        },
    }


def _merge_report(seed: Mapping[str, Any]) -> dict[str, Any]:
    report = template_report()
    seed_timings = seed.get("timings", {})
    if not isinstance(seed_timings, Mapping):
        raise ReportError("input timings must be an object")
    for spec in BUDGETS:
        timing_id = spec["id"]
        supplied = seed_timings.get(timing_id)
        if supplied is None:
            continue
        if not isinstance(supplied, Mapping):
            raise ReportError(f"timing {timing_id} must be an object")
        samples = supplied.get("samples_ms")
        if samples is not None:
            if not isinstance(samples, list):
                raise ReportError(f"timing {timing_id} samples_ms must be an array")
            if len(samples) not in (0, SAMPLE_COUNT):
                raise ReportError(
                    f"timing {timing_id} must contain exactly {SAMPLE_COUNT} samples or none"
                )
            if samples:
                try:
                    numeric = [float(sample) for sample in samples]
                except (TypeError, ValueError) as error:
                    raise ReportError(f"timing {timing_id} has a non-numeric sample") from error
                if any(not math.isfinite(sample) or sample < 0 for sample in numeric):
                    raise ReportError(f"timing {timing_id} samples must be finite and non-negative")
                measured = report["timings"][timing_id]
                measured.update(
                    {
                        "status": "pass" if p95(numeric) <= spec["budget_ms"] else "fail",
                        "measurement_kind": supplied.get("measurement_kind", "native-manual"),
                        "setup_runs": SETUP_COUNT,
                        "measured_runs": SAMPLE_COUNT,
                        "samples_ms": numeric,
                        "p95_ms": p95(numeric),
                        "reason": supplied.get("reason", "Ten samples recorded after one setup run."),
                    }
                )
                continue
        # A supplied status cannot promote an unmeasured timing.  This guards
        # against a hand-edited report that claims a budget without raw data.
        pending = report["timings"][timing_id]
        if supplied.get("status") not in (None, "pending"):
            raise ReportError(f"timing {timing_id} cannot claim status without ten samples")
        if "reason" in supplied:
            pending["reason"] = supplied["reason"]

    for section in ("scale_endurance", "provider_crashes", "tmux_transition_matrix", "local_checks"):
        if section in seed:
            report[section] = seed[section]
    return report


def _walk_values(value: Any, location: str = "report") -> list[tuple[str, str, Any]]:
    found: list[tuple[str, str, Any]] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            key_text = str(key)
            found.extend(_walk_values(child, f"{location}.{key_text}"))
            found.append((f"{location}.{key_text}", key_text.lower(), child))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(_walk_values(child, f"{location}[{index}]"))
    elif isinstance(value, str):
        found.append((location, "", value))
    return found


def _check_redaction(report: Mapping[str, Any]) -> None:
    for location, key, value in _walk_values(report):
        if any(part in key for part in FORBIDDEN_KEY_PARTS):
            # The contract itself uses ``ambient_paths`` and explicitly marks
            # them omitted; allow those fixed redaction labels while rejecting
            # all attempted identity/path fields elsewhere.
            if key not in {"ambient_paths", "absolute_paths", "machine_identifiers"}:
                raise ReportError(f"forbidden machine/path field at {location}")
        if isinstance(value, str) and ABSOLUTE_PATH.search(value):
            raise ReportError(f"absolute path leaked at {location}")


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ReportError(message)


def validate_report(report: Mapping[str, Any]) -> None:
    _require(report.get("schema_version") == SCHEMA_VERSION, "unsupported report schema")
    _require(report.get("gate") == GATE, "report gate must be Q5.2")
    policy = report.get("sample_policy")
    _require(isinstance(policy, Mapping), "sample_policy must be an object")
    _require(policy.get("setup_runs") == SETUP_COUNT, "setup run policy drifted")
    _require(policy.get("measured_runs") == SAMPLE_COUNT, "measured run policy drifted")
    _require(policy.get("percentile") == "nearest_rank_p95", "p95 policy drifted")
    _require(policy.get("raw_samples_preserved") is True, "raw sample preservation is required")

    timings = report.get("timings")
    _require(isinstance(timings, Mapping), "timings must be an object")
    _require(set(timings) == set(TIMING_IDS), "timing scenario set drifted")
    for spec in BUDGETS:
        timing_id = spec["id"]
        entry = timings[timing_id]
        _require(isinstance(entry, Mapping), f"timing {timing_id} must be an object")
        _require(entry.get("budget_ms") == spec["budget_ms"], f"budget drifted for {timing_id}")
        status = entry.get("status")
        _require(status in {"pending", "pass", "fail"}, f"invalid status for {timing_id}")
        samples = entry.get("samples_ms")
        _require(isinstance(samples, list), f"samples missing for {timing_id}")
        if status == "pending":
            _require(not samples, f"pending timing {timing_id} cannot contain samples")
            _require(entry.get("setup_runs") == 0, f"pending setup count for {timing_id}")
            _require(entry.get("measured_runs") == 0, f"pending measured count for {timing_id}")
            _require(entry.get("p95_ms") is None, f"pending p95 for {timing_id}")
        else:
            _require(len(samples) == SAMPLE_COUNT, f"timing {timing_id} needs ten raw samples")
            _require(entry.get("setup_runs") == SETUP_COUNT, f"timing {timing_id} needs one setup run")
            _require(entry.get("measured_runs") == SAMPLE_COUNT, f"timing {timing_id} needs ten measured runs")
            numeric = [float(sample) for sample in samples]
            _require(all(math.isfinite(sample) and sample >= 0 for sample in numeric), f"invalid sample in {timing_id}")
            calculated = p95(numeric)
            _require(entry.get("p95_ms") == calculated, f"p95 mismatch for {timing_id}")
            expected = "pass" if calculated <= spec["budget_ms"] else "fail"
            _require(status == expected, f"status does not match p95 for {timing_id}")
            _require(
                entry.get("measurement_kind") in {"native-manual", "native-automated", "automated-local"},
                f"unrecognised measurement kind for {timing_id}",
            )

    scale = report.get("scale_endurance")
    _require(isinstance(scale, Mapping), "scale_endurance must be an object")
    for key in (
        "workspaces",
        "live_agents",
        "editor_webviews",
        "hidden_surface_continuity",
        "window_reconstruction",
        "quit_relaunch",
    ):
        _require(isinstance(scale.get(key), Mapping), f"scale section {key} is missing")
        _require(scale[key].get("status") in {"pending", "pass", "fail"}, f"invalid scale status for {key}")
    workspaces = scale["workspaces"]
    if workspaces["status"] == "pass":
        _require(workspaces.get("observed") == 8, "scale pass requires eight Workspaces")
    agents = scale["live_agents"]
    if agents["status"] == "pass":
        _require(agents.get("observed", 0) >= 16, "scale pass requires sixteen live Agents")
        _require(agents.get("observed_workspace_distribution", 0) >= 4, "Agents must span four Workspaces")
    editors = scale["editor_webviews"]
    if editors["status"] == "pass":
        _require(editors.get("observed") == 9, "scale pass requires nine Editor WebViews")
        _require(editors.get("global_present") is True, "Global Editor identity is required")
        _require(editors.get("workspace_identity_count") == 8, "eight Workspace Editor identities are required")
    continuity = scale["hidden_surface_continuity"]
    if continuity["status"] == "pass":
        _require(continuity.get("observed_hidden_surfaces", 0) >= 5, "five hidden surfaces are required")
        _require(continuity.get("observed_hidden_minutes", 0) >= 10, "ten hidden minutes are required")
        _require(all(continuity.get("checks", {}).get(name) == "pass" for name in ("load_identity", "bridge_connection", "dirty_state", "input")), "hidden continuity checks are incomplete")
    reconstruction = scale["window_reconstruction"]
    if reconstruction["status"] == "pass":
        _require(reconstruction.get("observed_runs") == 10, "window reconstruction requires ten runs")
    relaunch = scale["quit_relaunch"]
    if relaunch["status"] == "pass":
        _require(relaunch.get("observed_runs") == 5, "quit/relaunch requires five runs")
        _require(all(relaunch.get("survival_checks", {}).get(name) == "pass" for name in ("agents", "workspace_tmux_sessions", "navigation")), "quit/relaunch survival checks are incomplete")

    crashes = report.get("provider_crashes")
    _require(isinstance(crashes, Mapping), "provider_crashes must be an object")
    _require(set(crashes) == set(CRASH_PROVIDERS), "provider crash scenario set drifted")
    for provider in CRASH_PROVIDERS:
        entry = crashes[provider]
        _require(entry.get("status") in {"pending", "pass", "fail"}, f"invalid crash status for {provider}")
        if entry["status"] == "pass":
            _require(entry.get("isolation_verified") is True, f"isolation missing for {provider}")
            _require(entry.get("recovery_verified") is True, f"recovery missing for {provider}")

    matrix = report.get("tmux_transition_matrix")
    _require(isinstance(matrix, Mapping), "tmux_transition_matrix must be an object")
    _require(matrix.get("required_cases") == list(TMUX_CASES), "tmux matrix case set drifted")
    _require(matrix.get("status") in {"pending", "pass", "fail"}, "invalid tmux matrix status")
    cases = matrix.get("cases")
    _require(isinstance(cases, Mapping) and set(cases) == set(TMUX_CASES), "tmux matrix cases are incomplete")
    _require(all(cases[case] in {"pending", "pass", "fail"} for case in TMUX_CASES), "invalid tmux case status")
    if matrix["status"] == "pass":
        _require(all(cases[case] == "pass" for case in TMUX_CASES), "tmux pass requires every case")

    checks = report.get("local_checks")
    _require(isinstance(checks, list), "local_checks must be an array")
    for check in checks:
        _require(isinstance(check, Mapping), "local check must be an object")
        _require(check.get("status") in {"pass", "fail", "skipped", "pending"}, "invalid local check status")
        _require(isinstance(check.get("id"), str) and check["id"], "local check id is required")

    redaction = report.get("redaction")
    _require(isinstance(redaction, Mapping), "redaction contract is missing")
    _require(redaction.get("machine_identifiers") == "omitted", "machine identifiers must be omitted")
    _require(redaction.get("absolute_paths") == "omitted", "absolute paths must be omitted")
    _check_redaction(report)


def _load_json(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReportError(f"cannot read JSON input {path.name}: {error}") from error
    if not isinstance(value, Mapping):
        raise ReportError("JSON report/input must be an object")
    return value


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def _self_test() -> None:
    report = template_report()
    report["timings"]["mounted_activity_switch"].update(
        {
            "status": "pass",
            "measurement_kind": "automated-local",
            "setup_runs": SETUP_COUNT,
            "measured_runs": SAMPLE_COUNT,
            "samples_ms": [1.0, 2.0, 2.0, 3.0, 3.0, 4.0, 4.0, 5.0, 5.0, 6.0],
            "p95_ms": 6.0,
            "reason": "Contract self-test only; not a native budget claim.",
        }
    )
    validate_report(report)
    report["timings"]["mounted_activity_switch"]["samples_ms"] = [1.0] * 9
    try:
        validate_report(report)
    except ReportError:
        return
    raise ReportError("self-test accepted a nine-sample budget")


def _print_plan() -> None:
    print(f"{GATE} acceptance plan (one setup + ten measured runs; nearest-rank p95)")
    for spec in BUDGETS:
        print(f"- {spec['id']}: p95 <= {spec['budget_ms']:.0f} ms ({spec['label']})")
    print("- scale: 8 Workspaces, 16 live Agents across >=4 Workspaces, 9 Editor WebViews")
    print("- continuity: hide >=5 for 10 minutes; verify identity, Bridge, dirty state, and input")
    print("- lifecycle: Window reconstruction x10; full Quit/relaunch x5 with providers surviving")
    print("- crashes: managed OpenVSCode, Herdr path, and one owned tmux session independently")
    print(f"- tmux cases: {', '.join(TMUX_CASES)}")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="validate the contract and optional report")
    mode.add_argument("--self-test", action="store_true", help="run validator self-tests")
    mode.add_argument("--plan", action="store_true", help="print the deterministic acceptance plan")
    mode.add_argument("--template", action="store_true", help="print a pending report template")
    mode.add_argument("--record", action="store_true", help="merge ten-sample input into a report")
    parser.add_argument("--input", type=Path, help="redacted JSON input for --record")
    parser.add_argument("--output", type=Path, help="output report path for --record")
    parser.add_argument("--report", type=Path, help="existing report to validate with --check")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        if args.plan:
            _print_plan()
            return 0
        if args.self_test:
            _self_test()
            print("Q5.2 report validator self-test: PASS")
            return 0
        if args.template:
            print(json.dumps(template_report(), indent=2) + "\n")
            return 0
        if args.record:
            if args.input is None or args.output is None:
                raise ReportError("--record requires --input and --output")
            report = _merge_report(_load_json(args.input))
            report["recorded_at_utc"] = datetime_module.datetime.now(datetime_module.timezone.utc).replace(microsecond=0).isoformat()
            validate_report(report)
            _write_json(args.output, report)
            print(f"Q5.2 report written: {args.output}")
            return 0
        if args.check:
            _self_test()
            if args.report is not None:
                validate_report(_load_json(args.report))
                print(f"Q5.2 report valid: {args.report}")
            else:
                validate_report(template_report())
            print("Q5.2 acceptance contract: PASS")
            return 0
    except ReportError as error:
        print(f"q5.2 performance report: {error}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
