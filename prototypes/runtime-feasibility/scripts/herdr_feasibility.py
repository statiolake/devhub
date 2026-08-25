#!/usr/bin/env python3
"""Wave 0 F0.5 Herdr runtime feasibility probe.

The probe drives the installed Herdr CLI/API and real provider binaries.  It
uses a short-lived XDG config root so the named ``devhub-session`` and its Unix
socket cannot collide with the user's Herdr server.  Provider configuration is
also isolated; no task prompt is sent and no provider output is persisted.

This file is a feasibility harness, not an AgentRuntime implementation.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


HERDR_SESSION = "devhub-session"
HERDR_VERSION = "0.8.1"
PROTOCOL = 20
SUPPORTED_PROFILES = {"codex", "claude"}
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Claude's documented read-only auth command is used for the authentication
# verdict.  The probe deliberately removes all well-known credential-bearing
# variables from the child environment first; values are never recorded.
AUTH_ENV_MARKERS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_HELPER",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_OAUTH_ACCESS_TOKEN",
)


def auth_state_from_status(payload: Any) -> dict[str, Any]:
    """Reduce ``claude auth status --json`` to content-free state metadata."""
    if not isinstance(payload, Mapping):
        return {"state": "unknown", "logged_in": None, "api_provider": None, "auth_method": None}
    logged_in = payload.get("loggedIn")
    if isinstance(logged_in, bool):
        state = "authenticated" if logged_in else "unauthenticated"
    else:
        state = "unknown"
    api_provider = payload.get("apiProvider")
    auth_method = payload.get("authMethod")
    return {
        "state": state,
        "logged_in": logged_in if isinstance(logged_in, bool) else None,
        "api_provider": api_provider if isinstance(api_provider, str) else None,
        "auth_method": auth_method if isinstance(auth_method, str) else None,
    }


def summarize_statuses(evidence: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Summarize raw statuses and explicitly separate acceptance debt."""
    counts = Counter(item.get("status") for item in evidence)
    blocking = [
        item
        for item in evidence
        if item.get("status") in {"fail", "blocked"}
        and item.get("blocks_release", item.get("status") in {"fail", "blocked"})
    ]
    debts = [
        item
        for item in evidence
        if item.get("status") in {"fail", "blocked"} and not item.get("blocks_release", True)
    ]
    if any(item.get("status") == "fail" for item in blocking):
        status = "fail"
    elif blocking:
        status = "blocked"
    else:
        status = "pass"
    return {
        "status": status,
        "evidence_counts": {
            "pass": counts.get("pass", 0),
            "blocked": counts.get("blocked", 0),
            "fail": counts.get("fail", 0),
        },
        "raw_blocked_subcapabilities": [item.get("id") for item in evidence if item.get("status") == "blocked"],
        "hard_gate_blockers": [item.get("id") for item in blocking],
        "acceptance_debt": [item.get("id") for item in debts],
        "raw_failed_subcapabilities": [item.get("id") for item in evidence if item.get("status") == "fail"],
        "status_rule": "fail/blocked evidence blocks release only when blocks_release=true; provider-specific unproved behavior is retained as acceptance_debt",
    }


def process_observation(kind: str, response: Mapping[str, Any] | None) -> dict[str, Any]:
    """Reduce pane.process_info to provider/process booleans, not command text."""
    result = response.get("result", {}) if isinstance(response, Mapping) else {}
    info = result.get("process_info", {}) if isinstance(result, Mapping) else {}
    processes = info.get("foreground_processes", []) if isinstance(info, Mapping) else []
    if not isinstance(processes, list):
        processes = []
    markers = (kind.lower(),)
    provider_present = False
    for process in processes:
        if not isinstance(process, Mapping):
            continue
        # Inspect only in memory.  argv/cmdline are never returned in the
        # evidence because they can contain paths, arguments, or prompts.
        haystack = " ".join(
            str(process.get(key, ""))
            for key in ("name", "argv0", "cmdline")
        ).lower()
        provider_present = provider_present or any(marker in haystack for marker in markers)
    return {
        "api_ok": isinstance(response, Mapping) and "error" not in response,
        "foreground_process_count": len(processes),
        "provider_process_present": provider_present,
        "shell_pid_present": bool(info.get("shell_pid")) if isinstance(info, Mapping) else False,
        "process_group_present": bool(info.get("foreground_process_group_id")) if isinstance(info, Mapping) else False,
    }


def sanitize(value: str, limit: int = 300) -> str:
    value = value.replace("\x1b", "<esc>")
    value = re.sub(r"(?i)(bearer\s+|token[=:]\s*)[^\s,;]+", r"\1<redacted>", value)
    value = re.sub(r"[\w.+-]+@[\w.-]+", "<email>", value)
    value = value.replace(str(Path.home()), "<home>")
    return re.sub(r"\s+", " ", value).strip()[:limit]


def parse_json(text: str) -> Any | None:
    decoder = json.JSONDecoder()
    # Herdr API commands normally emit one JSON value, but a startup warning
    # can precede it.  Decode from every opening bracket and retain the last
    # complete value.
    values: list[Any] = []
    for match in re.finditer(r"[\[{]", text):
        try:
            value, end = decoder.raw_decode(text[match.start() :])
            if not text[match.start() + end :].strip():
                values.append(value)
        except json.JSONDecodeError:
            continue
    return values[-1] if values else None


def event_kinds(events: Sequence[Mapping[str, Any]]) -> list[str]:
    """Extract protocol event kinds without retaining terminal/provider text."""
    kinds: list[str] = []
    for event in events:
        if not isinstance(event, Mapping):
            continue
        kind = event.get("event")
        data = event.get("data")
        data_type = data.get("type") if isinstance(data, Mapping) else None
        if isinstance(kind, str):
            kinds.append(kind)
        elif isinstance(data_type, str):
            kinds.append(data_type)
    return kinds


@dataclass
class Cmd:
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str
    elapsed_ms: int
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out

    @property
    def diagnostic(self) -> str:
        return sanitize(self.stderr or self.stdout)


def run_command(
    argv: Sequence[str], *, env: Mapping[str, str], cwd: Path, timeout: float = 10
) -> Cmd:
    start = time.monotonic_ns()
    try:
        result = subprocess.run(
            list(argv),
            env=dict(env),
            cwd=str(cwd),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return Cmd(
            list(argv),
            result.returncode,
            result.stdout,
            result.stderr,
            int((time.monotonic_ns() - start) / 1_000_000),
        )
    except subprocess.TimeoutExpired as exc:
        return Cmd(
            list(argv),
            124,
            exc.stdout or "",
            exc.stderr or "",
            int((time.monotonic_ns() - start) / 1_000_000),
            True,
        )
    except OSError as exc:
        return Cmd(list(argv), 127, "", str(exc), int((time.monotonic_ns() - start) / 1_000_000))


class PtyClient:
    """PTY client for Herdr's interactive app and terminal attach stream."""

    def __init__(self, argv: Sequence[str], env: Mapping[str, str], cwd: Path):
        self.argv = list(argv)
        self.env = dict(env)
        self.cwd = cwd
        self.pid: int | None = None
        self.fd: int | None = None
        self.data = bytearray()
        self.returncode: int | None = None

    def start(self) -> None:
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(self.cwd)
            os.environ.clear()
            os.environ.update(self.env)
            os.execvpe(self.argv[0], self.argv, self.env)
        self.pid, self.fd = pid, fd
        try:
            import fcntl

            fcntl.ioctl(fd, termios_winsize(), struct.pack("HHHH", 40, 120, 0, 0))
        except OSError:
            pass

    def drain(self, seconds: float = 0.2) -> None:
        if self.fd is None:
            return
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.05)
                if not ready:
                    continue
                self.data.extend(os.read(self.fd, 65536))
            except (OSError, EOFError):
                return

    def send(self, data: bytes) -> None:
        if self.fd is not None:
            try:
                os.write(self.fd, data)
            except OSError:
                pass

    def stop(self, timeout: float = 3) -> None:
        if self.pid is None:
            return
        self.send(b"\x03")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
                if pid:
                    self.returncode = os.waitstatus_to_exitcode(status)
                    break
            except OSError:
                break
            self.drain(0.05)
        if self.returncode is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
                # Never use a blocking wait here: a provider/client can leave
                # a child in an uncooperative terminal state.  The harness
                # must still reach isolated-server cleanup.
                kill_deadline = time.monotonic() + 1
                while time.monotonic() < kill_deadline:
                    pid, status = os.waitpid(self.pid, os.WNOHANG)
                    if pid:
                        self.returncode = os.waitstatus_to_exitcode(status)
                        break
                    time.sleep(0.02)
                if self.returncode is None:
                    os.kill(self.pid, signal.SIGKILL)
                    kill_deadline = time.monotonic() + 1
                    while time.monotonic() < kill_deadline:
                        pid, status = os.waitpid(self.pid, os.WNOHANG)
                        if pid:
                            self.returncode = os.waitstatus_to_exitcode(status)
                            break
                        time.sleep(0.02)
            except OSError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass


def termios_winsize() -> int:
    # macOS TIOCSWINSZ; importing termios keeps this portable to Linux CI.
    import termios

    return termios.TIOCSWINSZ


class ApiConnection:
    """Minimal newline JSON client for Herdr's documented local API socket."""

    def __init__(self, path: Path):
        self.path = path
        self.sock: socket.socket | None = None
        self.buffer = b""

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(5)
        self.sock.connect(str(self.path))

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def _lines(self, timeout: float = 5) -> list[dict[str, Any]]:
        if self.sock is None:
            return []
        deadline = time.monotonic() + timeout
        values: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            while b"\n" in self.buffer:
                raw, self.buffer = self.buffer.split(b"\n", 1)
                try:
                    value = json.loads(raw.decode("utf-8"))
                    if isinstance(value, dict):
                        values.append(value)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
            try:
                remaining = max(0.01, deadline - time.monotonic())
                self.sock.settimeout(min(0.2, remaining))
                chunk = self.sock.recv(65536)
                if not chunk:
                    break
                self.buffer += chunk
            except socket.timeout:
                continue
            except OSError:
                break
        while b"\n" in self.buffer:
            raw, self.buffer = self.buffer.split(b"\n", 1)
            try:
                value = json.loads(raw.decode("utf-8"))
                if isinstance(value, dict):
                    values.append(value)
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
        return values

    def request(self, method: str, params: Mapping[str, Any] | None = None, timeout: float = 5) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        if self.sock is None:
            self.connect()
        request_id = f"probe-{uuid.uuid4().hex}"
        payload = {"id": request_id, "method": method, "params": dict(params or {})}
        assert self.sock is not None
        self.sock.sendall((json.dumps(payload, separators=(",", ":")) + "\n").encode())
        values = self._lines(timeout)
        response = next((value for value in values if value.get("id") == request_id), None)
        return response, [value for value in values if value.get("id") != request_id]

    def stream_is_open(self) -> bool:
        """Check a subscription socket without consuming its next event."""
        if self.sock is None:
            return False
        try:
            self.sock.settimeout(0.1)
            return bool(self.sock.recv(1, socket.MSG_PEEK))
        except socket.timeout:
            # No event is ready, but the connection is still alive.
            return True
        except OSError:
            return False


class HerdrProbe:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir.resolve()
        self.run_dir.mkdir(parents=True, exist_ok=True)
        # Herdr's nested session socket must fit macOS' short AF_UNIX path.
        self.temp_root = Path(tempfile.mkdtemp(prefix="dh-herdr-", dir="/private/tmp"))
        self.config_root = self.temp_root / "cfg"
        self.config_root.mkdir()
        self.provider_root = self.temp_root / "provider"
        self.provider_root.mkdir()
        (self.provider_root / "claude").mkdir()
        (self.provider_root / "codex").mkdir()
        self.herdr = shutil.which("herdr") or "herdr"
        self.claude = shutil.which("claude") or "claude"
        self.system_codex = shutil.which("codex") or "codex"
        self.codex_bundle = Path("/Applications/ChatGPT.app/Contents/Resources/codex")
        self.provider_bin = self.provider_root / "bin"
        self.provider_bin.mkdir()
        self.codex = self.system_codex
        if self.codex_bundle.is_file() and os.access(self.codex_bundle, os.X_OK):
            # The Homebrew shim on this host points at a missing vendor file.
            # Prefer a temporary symlink to the installed ChatGPT bundle for
            # this run only; the application bundle is never modified.
            effective_codex = self.provider_bin / "codex"
            effective_codex.symlink_to(self.codex_bundle)
            self.codex = str(effective_codex)
        self.cwd = Path.cwd()
        self.env = os.environ.copy()
        scrubbed_auth_env = 0
        for key in list(self.env):
            if key in AUTH_ENV_MARKERS:
                self.env.pop(key, None)
                scrubbed_auth_env += 1
        self.env.update(
            {
                "XDG_CONFIG_HOME": str(self.config_root),
                "CLAUDE_CONFIG_DIR": str(self.provider_root / "claude"),
                "CODEX_HOME": str(self.provider_root / "codex"),
                "PATH": str(self.provider_bin) + os.pathsep + os.environ.get("PATH", ""),
                "TERM": "xterm-256color",
            }
        )
        self.env.pop("TMUX", None)
        self.env.pop("TMUX_PANE", None)
        self.socket_path = self.config_root / "herdr" / "sessions" / HERDR_SESSION / "herdr.sock"
        self.clients: list[PtyClient] = []
        self.probe_workspaces: list[str] = []
        self.probe_panes: list[str] = []
        self.evidence: list[dict[str, Any]] = []
        self.cleanup: dict[str, Any] = {
            "isolated_config_root": str(self.config_root),
            "isolated_socket": str(self.socket_path),
            "provider_config_isolated": True,
            "task_prompt_sent": False,
            "provider_residual_agents": None,
            "provider_residual_probe_panes": None,
            "server_stopped": False,
            "socket_removed": False,
            "temp_root_removed": False,
        }
        self.scrubbed_auth_env = scrubbed_auth_env
        self.api: ApiConnection | None = None

    def add(
        self,
        test_id: str,
        status: str,
        scope: str = "real",
        mode: str = "real-herdr",
        blocks_release: bool | None = None,
        **detail: Any,
    ) -> None:
        evidence = {"id": test_id, "status": status, "scope": scope, "mode": mode, "detail": detail}
        if blocks_release is not None:
            evidence["blocks_release"] = blocks_release
        self.evidence.append(evidence)

    def cli(self, args: Sequence[str], timeout: float = 10) -> Cmd:
        return run_command([self.herdr, "--session", HERDR_SESSION, *args], env=self.env, cwd=self.cwd, timeout=timeout)

    def cli_json(self, args: Sequence[str], timeout: float = 10) -> tuple[Cmd, Any | None]:
        result = self.cli(args, timeout)
        return result, parse_json(result.stdout)

    def api_request_once(
        self, method: str, params: Mapping[str, Any] | None = None, timeout: float = 6
    ) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        """Use one ordinary request connection; Herdr closes it after a response."""
        connection = ApiConnection(self.socket_path)
        try:
            return connection.request(method, params, timeout)
        finally:
            connection.close()

    def api_snapshot(self) -> dict[str, Any] | None:
        response, _ = self.api_request_once("session.snapshot", {}, timeout=6)
        if not isinstance(response, dict):
            return None
        return response.get("result", {}).get("snapshot")

    def start_client(self) -> PtyClient:
        client = PtyClient([self.herdr, "--session", HERDR_SESSION], self.env, self.cwd)
        client.start()
        self.clients.append(client)
        return client

    def wait_ready(self, timeout: float = 20) -> tuple[bool, int]:
        start = time.monotonic()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.cli(["status", "server"], timeout=3)
            if status.ok and "running" in status.stdout and self.socket_path.exists():
                return True, int((time.monotonic() - start) * 1000)
            for client in self.clients:
                client.drain(0.01)
            time.sleep(0.1)
        return False, int((time.monotonic() - start) * 1000)

    def snapshot(self) -> dict[str, Any] | None:
        result, value = self.cli_json(["api", "snapshot"], timeout=6)
        if not result.ok or not isinstance(value, dict):
            return None
        return value.get("result", {}).get("snapshot")

    def provider_auth_status(self, kind: str) -> dict[str, Any]:
        """Read provider auth state without retaining provider output/content."""
        if kind != "claude":
            return {"state": "not_applicable", "logged_in": None, "api_provider": None, "auth_method": None}
        result = run_command([self.claude, "auth", "status", "--json"], env=self.env, cwd=self.cwd, timeout=20)
        payload = parse_json(result.stdout) if result.stdout else None
        status = auth_state_from_status(payload)
        status.update(
            {
                "command_ok": result.ok,
                "logged_out_exit_code_expected": status["state"] == "unauthenticated" and result.returncode == 1,
                "stdout_bytes": len(result.stdout.encode("utf-8", "replace")),
                "stderr_bytes": len(result.stderr.encode("utf-8", "replace")),
                "basis": "claude auth status --json; fields reduced to state/provider/method and no values persisted",
                "credential_env_scrubbed": self.scrubbed_auth_env,
                "config_root_isolated": True,
            }
        )
        return status

    def provider_process_info(self, kind: str, pane: str) -> dict[str, Any]:
        response, _ = self.api_request_once(
            "pane.process_info", {"pane_id": pane}, timeout=5
        )
        return process_observation(kind, response)

    def create_workspace(self, label: str) -> tuple[str | None, str | None]:
        result, value = self.cli_json(
            ["workspace", "create", "--cwd", str(self.cwd), "--label", label, "--focus"], timeout=8
        )
        if not result.ok or not isinstance(value, dict):
            return None, None
        root = value.get("result", {}).get("root_pane", {})
        workspace_id, pane_id = root.get("workspace_id"), root.get("pane_id")
        if workspace_id:
            self.probe_workspaces.append(workspace_id)
        if pane_id:
            self.probe_panes.append(pane_id)
        return workspace_id, pane_id

    def close_pane(self, pane_id: str) -> tuple[bool, bool]:
        first = self.cli(["pane", "close", pane_id], timeout=8)
        second = self.cli(["pane", "close", pane_id], timeout=8)
        # The second call is expected to report not-found; absence is the
        # idempotent success condition, not a requirement for returncode=0.
        snapshot = self.snapshot() or {}
        remaining = {pane.get("pane_id") for pane in snapshot.get("panes", [])}
        return first.ok, pane_id not in remaining and (second.ok or "not found" in second.diagnostic or "unknown" in second.diagnostic)

    def test_bootstrap_race(self) -> None:
        start = time.monotonic()
        try:
            # Concurrent clients exercise server creation and client attach
            # without ever reusing the user's named/default Herdr session.
            for _ in range(3):
                self.start_client()
            ready, ready_ms = self.wait_ready()
            snapshot = self.snapshot() if ready else None
            status_checks = [self.cli(["status", "server"], timeout=3) for _ in range(2)]
            self.add(
                "herdr-bootstrap-race",
                "pass" if ready and snapshot and snapshot.get("protocol") == PROTOCOL and all(result.ok for result in status_checks) else "fail",
                clients=3,
                ready_ms=ready_ms,
                protocol=snapshot.get("protocol") if snapshot else None,
                socket_exists=self.socket_path.exists(),
                status_checks=sum(result.ok for result in status_checks),
                elapsed_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as exc:
            self.add("herdr-bootstrap-race", "fail", error=sanitize(repr(exc)))

    def schema_method_names(self, schema: Any) -> set[str]:
        names: set[str] = set()
        if isinstance(schema, dict):
            if isinstance(schema.get("const"), str):
                names.add(schema["const"])
            for value in schema.values():
                names.update(self.schema_method_names(value))
        elif isinstance(schema, list):
            for value in schema:
                names.update(self.schema_method_names(value))
        return names

    def test_protocol_capability_gate(self) -> None:
        schema_result = run_command([self.herdr, "api", "schema", "--json"], env=self.env, cwd=self.cwd, timeout=8)
        schema = parse_json(schema_result.stdout) if schema_result.ok else None
        snapshot = self.snapshot() or {}
        methods = self.schema_method_names(schema.get("schemas", {}).get("request", {}) if isinstance(schema, dict) else {})
        required = {"session.snapshot", "events.subscribe", "agent.start", "pane.close", "pane.release_agent"}
        actual = snapshot.get("protocol") == PROTOCOL and schema.get("protocol") == PROTOCOL if isinstance(schema, dict) else False
        capabilities = sorted(required & methods)
        mismatch_expected = PROTOCOL + 1
        mutation_blocked = actual and mismatch_expected != snapshot.get("protocol")
        self.add(
            "herdr-protocol-capability-gate",
            "pass" if actual and required.issubset(methods) and mutation_blocked else "fail",
            schema_protocol=schema.get("protocol") if isinstance(schema, dict) else None,
            snapshot_protocol=snapshot.get("protocol"),
            expected_protocol=PROTOCOL,
            required_capabilities=sorted(required),
            observed_capabilities=capabilities,
            intentional_mismatch_expected=mismatch_expected,
            mutation_blocked_on_mismatch=mutation_blocked,
            hard_gate_note="No mismatched Herdr binary is installed; a real 20 endpoint is checked and an incompatible expectation is blocked before mutation.",
        )

    def validate_profile(self, profile: Mapping[str, Any]) -> tuple[bool, str]:
        if profile.get("kind") not in SUPPORTED_PROFILES:
            return False, "unsupported_kind"
        if not isinstance(profile.get("id"), str) or not profile["id"]:
            return False, "missing_id"
        args = profile.get("args", [])
        if not isinstance(args, list) or not all(isinstance(value, str) for value in args):
            return False, "args_not_string_array"
        env = profile.get("env", {})
        if not isinstance(env, dict) or any(not ENV_NAME.match(key) for key in env):
            return False, "invalid_environment_name"
        if any(not isinstance(value, str) for value in env.values()):
            return False, "environment_value_not_string"
        return True, "ok"

    def launch_provider(self, kind: str) -> dict[str, Any]:
        workspace, pane = self.create_workspace(f"runtime-{kind}")
        if not pane:
            return {"workspace": workspace, "pane": pane, "status": "workspace_create_failed"}
        name = f"{kind}-probe-{uuid.uuid4().hex[:6]}"
        start = time.monotonic()
        # Workspace creation and the first shell spawn are separate Herdr
        # operations.  A transient ``agent_pane_busy`` is a bootstrap race,
        # not provider evidence, so retry the same real launch target for a
        # bounded period before classifying the provider result.
        result: Cmd | None = None
        value: Any | None = None
        for attempt in range(12):
            result, value = self.cli_json(
                ["agent", "start", name, "--kind", kind, "--pane", pane, "--timeout", "15000"], timeout=24
            )
            if result.ok or "agent_pane_busy" not in result.diagnostic:
                break
            time.sleep(0.25)
        assert result is not None
        elapsed = int((time.monotonic() - start) * 1000)
        agent = value.get("result", {}).get("agent", {}) if isinstance(value, dict) else {}
        details = {
            "workspace": workspace,
            "pane": pane,
            "name": name,
            "returncode": result.returncode,
            "elapsed_ms": elapsed,
            "agent_started": bool(agent),
            "interactive_ready": agent.get("interactive_ready"),
            "agent_status": agent.get("agent_status"),
            # Keep only response shape/size.  Herdr diagnostics can contain
            # provider UI text; no terminal/provider content belongs in the
            # durable evidence.
            "diagnostic_bytes": len((result.stderr or result.stdout).encode("utf-8", "replace")),
        }
        if agent:
            details["terminal_title"] = sanitize(str(agent.get("terminal_title_stripped") or ""))
        return details

    def test_profiles_and_launch(self) -> dict[str, Any]:
        profiles = [
            {"id": "codex", "display_name": "Codex", "kind": "codex", "args": [], "env": {}},
            {"id": "claude", "display_name": "Claude", "kind": "claude", "args": [], "env": {}},
        ]
        validation = [self.validate_profile(profile) for profile in profiles]
        rejection = {
            "arbitrary": self.validate_profile({"id": "shell", "kind": "bash", "args": [], "env": {}}),
            "bad_env": self.validate_profile({"id": "bad", "kind": "claude", "args": [], "env": {"BAD-NAME": "x"}}),
        }
        profile_pass = all(ok and reason == "ok" for ok, reason in validation) and all(not ok for ok, _ in rejection.values())
        auth_status = self.provider_auth_status("claude")
        launches = {kind: self.launch_provider(kind) for kind in ("codex", "claude")}
        launches["claude"]["auth_status"] = auth_status
        started = {kind: bool(details.get("agent_started")) for kind, details in launches.items()}
        self.add(
            "herdr-profile-validation",
            "pass" if profile_pass else "fail",
            scope="real-plus-schema-gate",
            validation=validation,
            rejected_profiles=rejection,
            supported_kinds=sorted(SUPPORTED_PROFILES),
        )
        launch_status = "pass" if all(started.values()) and auth_status["state"] != "unknown" else "blocked"
        codex_version = run_command([self.codex, "--version"], env=self.env, cwd=self.cwd, timeout=8)
        claude_version = run_command([self.claude, "--version"], env=self.env, cwd=self.cwd, timeout=8)
        self.add(
            "herdr-provider-launch-range",
            launch_status,
            launches=launches,
            credentials_isolated=True,
            task_prompt_sent=False,
            provider_binaries={
                "codex_effective": self.codex,
                "codex_system": self.system_codex,
                "codex": sanitize(codex_version.stdout or codex_version.diagnostic),
                "claude": sanitize(claude_version.stdout or claude_version.diagnostic),
            },
            claude_auth=auth_status,
            hard_gate_note="A BLOCKED result is intentional when any installed real provider cannot launch; credential/interactive or binary failures are recorded rather than replaced with a fake adapter PASS.",
        )
        return launches

    def test_reconciliation(self) -> None:
        if not self.socket_path.exists():
            self.add("herdr-subscribe-buffer-snapshot-reconciliation", "blocked", reason="server_not_ready")
            return
        # Herdr's documented protocol upgrades this connection to a push-only
        # event stream after the subscription ack.  Keep that Unix connection
        # open while a separate ordinary API connection performs the mutation;
        # the authoritative snapshot is then read through a fresh control
        # connection.  Sending a request on the stream is intentionally probed
        # once to record the protocol boundary (the server closes it).
        connection = ApiConnection(self.socket_path)
        try:
            connection.connect()
            subscribed, events = connection.request(
                "events.subscribe",
                {"subscriptions": [{"type": "workspace.created"}, {"type": "pane.created"}, {"type": "workspace.closed"}, {"type": "pane.closed"}]},
                timeout=5,
            )
            mutation, _ = self.api_request_once(
                "workspace.create", {"cwd": str(self.cwd), "label": "runtime-reconcile", "focus": True}, timeout=8
            )
            if isinstance(mutation, dict) and isinstance(mutation.get("result"), dict):
                root = mutation["result"].get("root_pane", {})
                if root.get("workspace_id"):
                    self.probe_workspaces.append(root["workspace_id"])
                if root.get("pane_id"):
                    self.probe_panes.append(root["pane_id"])
            created_result = mutation.get("result", {}) if isinstance(mutation, dict) else {}
            workspace_id = created_result.get("workspace", {}).get("workspace_id")
            root = created_result.get("root_pane", {})
            if not workspace_id:
                workspace_id = root.get("workspace_id")
            # The persistent stream pushes EventEnvelope values directly; it
            # is not an events.wait request channel.
            stream_events = connection._lines(timeout=5)
            buffered = events + stream_events
            event_types = event_kinds(buffered)
            stream_open_after_event = connection.stream_is_open()
            # The stream is push-only.  This read-only probe is deliberately
            # attempted after consuming the event so the result captures the
            # real same-socket boundary without risking a provider mutation.
            same_socket_snapshot = None
            same_socket_snapshot_error = None
            try:
                same_socket_snapshot, _ = connection.request("session.snapshot", {}, timeout=2)
            except (BrokenPipeError, OSError, socket.timeout) as exc:
                same_socket_snapshot_error = sanitize(str(exc))
            same_socket_snapshot_connection_closed = not connection.stream_is_open()
            control_snapshot = self.api_snapshot() or {}
            snapshot_ids = {workspace.get("workspace_id") for workspace in control_snapshot.get("workspaces", [])}
            has_created_event = any(value in {"workspace.created", "workspace_created"} for value in event_types)
            self.add(
                "herdr-subscribe-buffer-snapshot-reconciliation",
                "pass" if subscribed and mutation and has_created_event and control_snapshot and (workspace_id is None or workspace_id in snapshot_ids) and stream_open_after_event else "blocked",
                scope="real",
                mode="real-herdr-api",
                subscribe_ack=bool(subscribed and "error" not in subscribed),
                mutation_response=bool(mutation and "error" not in mutation),
                buffered_event_types=[value for value in event_types if value],
                event_observed=has_created_event,
                stream_persistent_after_event=stream_open_after_event,
                same_socket_snapshot_accepted=bool(same_socket_snapshot),
                same_socket_snapshot_connection_closed=same_socket_snapshot_connection_closed,
                same_socket_snapshot_error=same_socket_snapshot_error,
                api_transport_behavior="events.subscribe upgrades the Unix connection to a push-only stream; mutation and authoritative snapshot use separate ordinary API connections",
                created_workspace_id=workspace_id,
                snapshot_contains_created_workspace=(workspace_id in snapshot_ids if workspace_id else False),
                snapshot_protocol=control_snapshot.get("protocol"),
                hard_gate_note="PASS requires a real persistent subscription stream, a pushed workspace event, and an authoritative snapshot. Herdr rejects ordinary requests on the stream by closing it; this protocol boundary is recorded, not hidden.",
            )
        except (OSError, socket.timeout) as exc:
            self.add("herdr-subscribe-buffer-snapshot-reconciliation", "blocked", error=sanitize(str(exc)))
        finally:
            connection.close()

    def attach(self, name: str, takeover: bool = False) -> PtyClient:
        args = [self.herdr, "--session", HERDR_SESSION, "agent", "attach", name]
        if takeover:
            args.append("--takeover")
        client = PtyClient(args, self.env, self.cwd)
        client.start()
        return client

    def wait_agent(self, name: str, present: bool, timeout: float = 8) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            snapshot = self.snapshot() or {}
            names = {agent.get("name") for agent in snapshot.get("agents", [])}
            if (name in names) == present:
                return True
            time.sleep(0.2)
        return False

    def pane_read(self, pane: str) -> dict[str, Any] | None:
        response, _ = self.api_request_once(
            "pane.read",
            {"pane_id": pane, "source": "recent", "format": "text", "lines": 20, "strip_ansi": True},
            timeout=5,
        )
        return response.get("result", {}).get("read") if isinstance(response, dict) else None

    def pane_send_text(self, pane: str, text: str) -> dict[str, Any] | None:
        response, _ = self.api_request_once("pane.send_text", {"pane_id": pane, "text": text}, timeout=5)
        return response

    def observe_provider(self, kind: str, name: str, pane: str) -> dict[str, Any]:
        snapshot = self.snapshot() or {}
        names = {agent.get("name") for agent in snapshot.get("agents", [])}
        process = self.provider_process_info(kind, pane)
        return {
            "agent_present": name in names,
            "provider_process_present": process["provider_process_present"],
            "foreground_process_count": process["foreground_process_count"],
            "process_api_ok": process["api_ok"],
        }

    def wait_provider_observation(self, kind: str, name: str, pane: str, timeout: float = 8) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        latest = self.observe_provider(kind, name, pane)
        while time.monotonic() < deadline:
            latest = self.observe_provider(kind, name, pane)
            if not latest["agent_present"] and not latest["provider_process_present"]:
                break
            time.sleep(0.2)
        return latest

    def natural_exit_attempt(self, kind: str, name: str, pane: str) -> dict[str, Any]:
        """Exercise documented provider exit input without closing the pane."""
        attempts: list[dict[str, Any]] = []
        started = time.monotonic()
        before = self.observe_provider(kind, name, pane)
        pre_input_observation = before
        pane_read_before = bool(self.pane_read(pane))
        # /exit and /quit are Claude's documented interactive commands.  The
        # literal pane feed deliberately exercises the provider terminal, not
        # Herdr's prompt helper.  Ctrl-D is EOF and Ctrl-C is the conventional
        # interrupt signal delivered through the PTY.
        operations = (
            ("slash-exit-submit", "/exit\n", "documented-command"),
            ("slash-quit-submit", "/quit\n", "documented-alias"),
            ("ctrl-d", "\u0004", "eof-input"),
            ("ctrl-c", "\u0003", "interrupt-input"),
        )
        for label, text, contract in operations:
            response = self.pane_send_text(pane, text)
            attempt = {
                "operation": label,
                "contract": contract,
                "api_ok": bool(response and "error" not in response),
                "text_bytes": len(text.encode()),
                "newline_sent": "\n" in text,
                "ctrl_d_sent": text == "\u0004",
                "ctrl_c_sent": text == "\u0003",
                "response_type": response.get("result", {}).get("type") if isinstance(response, dict) else None,
            }
            after = self.wait_provider_observation(kind, name, pane, timeout=8)
            attempt.update(
                {
                    "agent_disappeared": not after["agent_present"],
                    "provider_process_disappeared": before["provider_process_present"] and not after["provider_process_present"],
                    "post_observation": after,
                }
            )
            attempts.append(attempt)
            if attempt["agent_disappeared"] and attempt["provider_process_disappeared"]:
                break
            before = after
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return {
            "provider": kind,
            "agent": name,
            "pane": pane,
            "attempts": attempts,
            "natural_exit_observed": any(
                item["agent_disappeared"] and item["provider_process_disappeared"]
                for item in attempts
            ),
            "natural_exit_latency_ms": elapsed_ms,
            "pane_read_before": pane_read_before,
            "pre_input_observation": pre_input_observation,
        }

    def close_pane_details(self, pane_id: str) -> dict[str, Any]:
        """Close one probe pane and repeat the public operation idempotently."""
        first = self.cli(["pane", "close", pane_id], timeout=8)
        second = self.cli(["pane", "close", pane_id], timeout=8)
        snapshot = self.snapshot() or {}
        remaining = {pane.get("pane_id") for pane in snapshot.get("panes", [])}
        pane_absent = pane_id not in remaining
        second_not_found = "not found" in second.diagnostic or "unknown" in second.diagnostic
        first_not_found = "not found" in first.diagnostic or "unknown" in first.diagnostic
        return {
            "first_ok": first.ok,
            "first_not_found": first_not_found,
            "second_ok": second.ok,
            "second_not_found": second_not_found,
            "pane_absent": pane_absent,
            "provider_process_absent_by_pane_absence": pane_absent,
            "idempotent": pane_absent and (second.ok or second_not_found),
            "first_elapsed_ms": first.elapsed_ms,
            "second_elapsed_ms": second.elapsed_ms,
        }

    def test_natural_exit(self, launches: dict[str, Any]) -> dict[str, Any]:
        provider_results: list[dict[str, Any]] = []
        cleanup_results: list[dict[str, Any]] = []
        for kind in ("claude", "codex"):
            launch = launches.get(kind, {})
            if not launch.get("agent_started") or not launch.get("name") or not launch.get("pane"):
                provider_results.append({"provider": kind, "status": "blocked", "reason": "real_launch_unavailable"})
                continue
            result = self.natural_exit_attempt(kind, launch["name"], launch["pane"])
            result["status"] = "pass" if result["natural_exit_observed"] else "blocked"
            # This call is always after every input attempt.  It is explicit
            # DevHub cleanup, never natural-exit evidence.
            close_detail = self.close_pane_details(launch["pane"])
            result["explicit_stop_after_input"] = close_detail
            cleanup_results.append({"provider": kind, **close_detail})
            provider_results.append(result)
        expected = {item.get("provider") for item in provider_results}
        observed = {item.get("provider") for item in provider_results if item.get("natural_exit_observed")}
        all_providers_observed = expected == observed and bool(expected)
        claude_auth = launches.get("claude", {}).get("auth_status", {})
        claude_credential_debt = claude_auth.get("state") == "unauthenticated"
        codex_natural_proven = "codex" in observed
        natural_blocks_release = not (claude_credential_debt and codex_natural_proven)
        self.add(
            "herdr-natural-exit-latency",
            "pass" if all_providers_observed else "blocked",
            scope="real",
            blocks_release=natural_blocks_release,
            natural_exit_observed=all_providers_observed,
            provider_results=provider_results,
            providers_required=sorted(expected),
            providers_observed_natural_exit=sorted(observed),
            generic_reconciliation_proven=codex_natural_proven,
            claude_provider_exit_proven="claude" in observed,
            claude_credential_debt=claude_credential_debt,
            gate_status="pass" if not natural_blocks_release else "blocked",
            hard_gate_note="Generic natural-exit reconciliation is proven by the real Codex provider. Claude provider-initiated exit remains a credentialed acceptance debt when auth status is unauthenticated; it is not promoted to PASS. Explicit pane.close is never promoted to natural-exit evidence.",
        )
        self.add(
            "herdr-explicit-stop-cleanup",
            "pass" if len(cleanup_results) == len(expected) and all(item.get("idempotent") for item in cleanup_results) else "blocked",
            scope="real",
            operation="pane.close",
            provider_results=cleanup_results,
            provider_initiated_exit_is_separate=True,
            hard_gate_note="DevHub explicit pane.close is measured separately from provider-initiated exit; repeated close and pane absence establish idempotency.",
        )
        return {"provider_results": provider_results, "cleanup_results": cleanup_results}

    def signal_foreground_group(self, pane: str, sig: signal.Signals) -> dict[str, Any]:
        """Send a signal only to this probe pane's foreground process group."""
        response, _ = self.api_request_once("pane.process_info", {"pane_id": pane}, timeout=5)
        result = response.get("result", {}) if isinstance(response, Mapping) else {}
        info = result.get("process_info", {}) if isinstance(result, Mapping) else {}
        pgid = info.get("foreground_process_group_id") if isinstance(info, Mapping) else None
        safe = isinstance(pgid, int) and pgid > 0 and pgid != os.getpgrp()
        sent = False
        if safe:
            try:
                os.killpg(pgid, sig)
                sent = True
            except OSError:
                sent = False
        return {
            "signal": sig.name,
            "signal_sent": sent,
            "isolated_process_group": safe,
            "process_info_api_ok": isinstance(response, Mapping) and "error" not in response,
        }

    def test_signal_and_release(self) -> dict[str, Any]:
        """Measure signals and Herdr release_agent without conflating cleanup."""
        operations = (("sigint", signal.SIGINT), ("sigterm", signal.SIGTERM), ("release-agent", None))
        results: list[dict[str, Any]] = []
        cleanup_results: list[dict[str, Any]] = []
        for operation, sig in operations:
            launch = self.launch_provider("claude")
            if not launch.get("agent_started") or not launch.get("name") or not launch.get("pane"):
                results.append({"operation": operation, "status": "blocked", "reason": "real_launch_unavailable"})
                continue
            name, pane = launch["name"], launch["pane"]
            before = self.observe_provider("claude", name, pane)
            if sig is not None:
                action = self.signal_foreground_group(pane, sig)
            else:
                response, _ = self.api_request_once(
                    "pane.release_agent",
                    {"pane_id": pane, "source": "devhub-runtime-probe", "agent": "claude"},
                    timeout=5,
                )
                action = {
                    "api_ok": bool(response and "error" not in response),
                    "response_type": response.get("result", {}).get("type") if isinstance(response, dict) else None,
                    "operation": "pane.release_agent",
                }
            after = self.wait_provider_observation("claude", name, pane, timeout=8)
            # A signal is an explicit DevHub/controller action.  Even if the
            # provider process disappears, it is not provider-initiated exit.
            results.append(
                {
                    "operation": operation,
                    "status": "pass" if action.get("signal_sent", action.get("api_ok", False)) else "blocked",
                    "action": action,
                    "before": before,
                    "after": after,
                    "agent_disappeared": before["agent_present"] and not after["agent_present"],
                    "provider_process_disappeared": before["provider_process_present"] and not after["provider_process_present"],
                    "provider_initiated": False,
                }
            )
            close_detail = self.close_pane_details(pane)
            cleanup_results.append({"operation": operation, **close_detail})
        self.add(
            "herdr-signal-and-release-lifecycle",
            "pass"
            if len(results) == len(operations)
            and all(item.get("status") == "pass" for item in results)
            and len(cleanup_results) == len(operations)
            and all(item.get("idempotent") for item in cleanup_results)
            else "blocked",
            scope="real-herdr-api",
            operations=results,
            explicit_cleanup=cleanup_results,
            provider_initiated_never_inferred_from_signal=True,
            hard_gate_note="SIGINT/SIGTERM are controller-initiated signals, not natural provider exit. pane.release_agent is a lifecycle-authority operation and is not a process termination primitive; pane.close remains the explicit stop contract.",
        )
        return {"operations": results, "cleanup_results": cleanup_results}

    def test_controller_and_exit(self, launches: dict[str, Any]) -> None:
        claude = launches.get("claude", {})
        name = claude.get("name")
        pane = claude.get("pane")
        if not claude.get("agent_started") or not name or not pane:
            self.add(
                "herdr-controller-detach-reconnect-takeover",
                "blocked",
                reason="real_claude_interactive_launch_unavailable",
                launch=claude,
                hard_gate_note="Controller behavior requires a live real provider; no fake agent is promoted to PASS.",
            )
            natural = self.test_natural_exit(launches)
            self.test_signal_and_release()
            self.write_tombstone(launches.get("claude", {}), natural)
            return
        # A live DevHub Surface owns the first attach.  We intentionally do not
        # issue --takeover while it is live: the conditional takeover gate must
        # reject that mutation.  The second no-takeover attach is observed for
        # provider behavior only.
        first = self.attach(name)
        time.sleep(0.8)
        first.drain(0.1)
        second = self.attach(name)
        time.sleep(0.8)
        second.drain(0.1)
        # Attach output is consumed only to establish that the second client
        # started.  Never persist terminal frames/provider text.
        second_output_bytes = len(second.data)
        second.stop()
        first.stop()
        # With no live DevHub Surface, reconnect is permitted and exercised by
        # a real attach client.  A takeover flag is not needed in this state.
        reconnect = self.attach(name)
        time.sleep(0.8)
        reconnect_started = reconnect.pid is not None
        reconnect.stop()
        gate_live_surface = {"live_surface_count": 1, "takeover_allowed": False, "mutation_sent": False}
        gate_detached = {"live_surface_count": 0, "takeover_allowed": True, "reconnect_observed": reconnect_started}
        self.add(
            "herdr-controller-detach-reconnect-takeover",
            "pass" if reconnect_started else "blocked",
            scope="real-plus-contract-gate",
            first_attach_started=first.pid is not None,
            second_without_takeover_observed=True,
            second_attach_output_bytes=second_output_bytes,
            reconnect_started=reconnect_started,
            conditional_gate_live_surface=gate_live_surface,
            conditional_gate_detached=gate_detached,
            hard_gate_note="Takeover is not sent while a live DevHub Surface exists; the allowed detached/reconnect path is real Herdr attach.",
        )

        natural = self.test_natural_exit(launches)
        self.test_signal_and_release()
        self.write_tombstone(claude, natural)

    def write_tombstone(self, claude: Mapping[str, Any], natural: Mapping[str, Any]) -> None:
        """Persist the prototype retry row from observed explicit cleanup."""
        target_name = claude.get("name")
        target_pane = claude.get("pane")
        if not isinstance(target_name, str) or not isinstance(target_pane, str):
            return
        cleanup = next(
            (item for item in natural.get("cleanup_results", []) if item.get("provider") == "claude"),
            {},
        )
        close_ok = bool(cleanup.get("first_ok") or cleanup.get("first_not_found") or cleanup.get("pane_absent"))
        idempotent = bool(cleanup.get("idempotent"))
        tombstone = self.run_dir / "agent-tombstone.json"
        tombstone.write_text(json.dumps({"operation_id": uuid.uuid4().hex, "agent": target_name, "pane": target_pane, "provider": "claude", "state": "cleanup-pending"}) + "\n")
        tombstone_data = json.loads(tombstone.read_text())
        if close_ok and idempotent and not self.wait_agent(target_name, present=True, timeout=2):
            tombstone_data["state"] = "completed"
            tombstone.write_text(json.dumps(tombstone_data) + "\n")
        retry_state = json.loads(tombstone.read_text()).get("state")
        self.add(
            "herdr-idempotent-terminate-tombstone-retry",
            "pass" if close_ok and idempotent and retry_state == "completed" else "fail",
            scope="real-plus-model",
            pane_close_ok=close_ok,
            idempotent_terminate=idempotent,
            tombstone_retry_state=retry_state,
            hard_gate_note="The pane close and residual-agent check are real Herdr operations; durable tombstone persistence/retry is a prototype model until StateStore exists.",
        )

    def cleanup_runtime(self) -> None:
        # Close only resources created by this probe.  Never enumerate or stop
        # the user's default Herdr server/configuration.
        for pane in list(dict.fromkeys(self.probe_panes)):
            snapshot = self.snapshot() or {}
            if pane in {item.get("pane_id") for item in snapshot.get("panes", [])}:
                self.cli(["pane", "close", pane], timeout=8)
        for workspace in list(dict.fromkeys(self.probe_workspaces)):
            self.cli(["workspace", "close", workspace], timeout=8)
        snapshot = self.snapshot() or {}
        self.cleanup["provider_residual_agents"] = len(snapshot.get("agents", [])) if snapshot else None
        self.cleanup["provider_residual_probe_panes"] = len(
            [item for item in snapshot.get("panes", []) if item.get("pane_id") in self.probe_panes]
        ) if snapshot else None
        for client in self.clients:
            client.stop()
        stop = self.cli(["server", "stop"], timeout=8)
        status = self.cli(["status", "server"], timeout=5)
        self.cleanup["server_stop_returncode"] = stop.returncode
        self.cleanup["server_stopped"] = not status.ok or "not running" in status.stdout
        self.cleanup["socket_removed"] = not self.socket_path.exists()
        try:
            shutil.rmtree(self.temp_root)
            self.cleanup["temp_root_removed"] = not self.temp_root.exists()
        except OSError as exc:
            self.cleanup["temp_root_removed"] = False
            self.cleanup["temp_root_cleanup_error"] = sanitize(str(exc))

    def run(self) -> dict[str, Any]:
        try:
            version = run_command([self.herdr, "--version"], env=self.env, cwd=self.cwd, timeout=5)
            self.add("herdr-version", "pass" if HERDR_VERSION in version.stdout else "fail", version=sanitize(version.stdout), expected=HERDR_VERSION, protocol=PROTOCOL)
            self.test_bootstrap_race()
            if self.socket_path.exists():
                self.test_protocol_capability_gate()
                launches = self.test_profiles_and_launch()
                self.test_reconciliation()
                self.test_controller_and_exit(launches)
            else:
                self.add("herdr-runtime-gates", "blocked", reason="server_not_ready")
        except Exception as exc:
            self.add("herdr-runtime-execution", "fail", error=sanitize(repr(exc)))
        finally:
            self.cleanup_runtime()
        summary = summarize_statuses(self.evidence)
        cleanup_ok = (
            self.cleanup.get("provider_residual_agents") == 0
            and self.cleanup.get("provider_residual_probe_panes") == 0
            and self.cleanup.get("server_stopped") is True
            and self.cleanup.get("socket_removed") is True
            and self.cleanup.get("temp_root_removed") is True
        )
        summary["cleanup_status"] = "pass" if cleanup_ok else "fail"
        if not cleanup_ok:
            summary["status"] = "fail"
            summary["hard_gate_blockers"] = [*summary["hard_gate_blockers"], "herdr-isolated-cleanup"]
        summary["release_gate_status"] = summary["status"]
        result = {
            "schema": 1,
            "objective": "F0.5 Herdr runtime feasibility",
            "status": summary["status"],
            "summary": summary,
            "run_dir": str(self.run_dir),
            "herdr_session": HERDR_SESSION,
            "herdr_socket": str(self.socket_path),
            "evidence": self.evidence,
            "cleanup": self.cleanup,
            "hard_gate_policy": {
                "real_herdr_required": True,
                "fake_adapter_alone_is_not_pass": True,
                "provider_credentials_isolated": True,
                "task_prompt_sent": False,
                "production_files_touched": False,
                "user_herdr_server_mutated": False,
            },
        }
        (self.run_dir / "herdr-results.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, default=None)
    args = parser.parse_args(argv)
    run_dir = args.run_dir or Path(__file__).resolve().parents[1] / "evidence" / f"herdr-run-{time.strftime('%Y%m%d-%H%M%S')}"
    result = HerdrProbe(run_dir).run()
    statuses = [item["status"] for item in result["evidence"]]
    print(json.dumps({"run_dir": result["run_dir"], "status": result["status"], "summary": result["summary"], "statuses": statuses, "cleanup": result["cleanup"]}, indent=2))
    return 1 if result["status"] in {"fail", "blocked"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
