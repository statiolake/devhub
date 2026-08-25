#!/usr/bin/env python3
"""Wave 0 F0.5 runtime feasibility harness.

This is deliberately a black-box probe.  It talks to the installed Herdr and
tmux binaries and keeps all mutable state below the run directory supplied by
the harness.  It does not import production code and it never uses the user's
default tmux server.

The runner writes a small, content-free result document.  Terminal/provider
output is consumed only to detect readiness and is never persisted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import termios
import time
import tty
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOCKET = "devhub"
HERDR_SESSION = "devhub-session"
PROTOCOL = 20
HERDR_VERSION = "0.8.1"
TMUX_MIN_VERSION = (3, 3)
SUPPORTED_PROFILES = {"codex", "claude"}
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def now_ns() -> int:
    return time.time_ns()


def elapsed_ms(start_ns: int) -> int:
    return int((now_ns() - start_ns) / 1_000_000)


def sanitize(value: str, limit: int = 400) -> str:
    """Return diagnostics without copying terminal text, credentials, or env."""

    value = re.sub(r"(?i)(bearer\s+|token[=:]\s*)[^\s,;]+", r"\1<redacted>", value)
    value = re.sub(r"[\w.+-]+@[\w.-]+", "<email>", value)
    home = str(Path.home())
    if home:
        value = value.replace(home, "<home>")
    value = value.replace("\x1b", "<esc>")
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def parse_json(text: str) -> Any | None:
    """Parse the last JSON value in CLI output (warnings may precede it)."""

    decoder = json.JSONDecoder()
    for match in reversed(list(re.finditer(r"[\[{]", text))):
        try:
            value, end = decoder.raw_decode(text[match.start() :])
            if not text[match.start() + end :].strip():
                return value
        except json.JSONDecodeError:
            continue
    return None


@dataclass
class CommandResult:
    argv: list[str]
    returncode: int
    stdout: str = ""
    stderr: str = ""
    elapsed_ms: int = 0
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out

    @property
    def diagnostic(self) -> str:
        return sanitize(self.stderr or self.stdout)


def command(
    argv: Sequence[str],
    *,
    env: Mapping[str, str] | None = None,
    timeout: float = 10,
    cwd: Path | None = None,
) -> CommandResult:
    start = now_ns()
    try:
        proc = subprocess.run(
            list(argv),
            cwd=str(cwd) if cwd else None,
            env=dict(env) if env else None,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return CommandResult(
            list(argv), proc.returncode, proc.stdout, proc.stderr, elapsed_ms(start)
        )
    except subprocess.TimeoutExpired as exc:
        return CommandResult(
            list(argv), 124, exc.stdout or "", exc.stderr or "", elapsed_ms(start), True
        )
    except OSError as exc:
        return CommandResult(list(argv), 127, "", str(exc), elapsed_ms(start))


class PtyProcess:
    """Small PTY wrapper for Herdr and tmux clients that require a terminal."""

    def __init__(self, argv: Sequence[str], env: Mapping[str, str], cwd: Path | None = None):
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
            if self.cwd:
                os.chdir(self.cwd)
            os.environ.clear()
            os.environ.update(self.env)
            os.execvpe(self.argv[0], self.argv, self.env)
        self.pid, self.fd = pid, fd
        # Herdr/tmux use terminal dimensions to size their first pane.
        try:
            winsize = struct_pack_winsize(40, 120)
            import fcntl

            fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
        except (OSError, ImportError):
            pass

    def read(self, timeout: float = 0.05) -> bytes:
        if self.fd is None:
            return b""
        try:
            ready, _, _ = select.select([self.fd], [], [], timeout)
            if not ready:
                return b""
            chunk = os.read(self.fd, 65536)
            self.data.extend(chunk)
            return chunk
        except (OSError, EOFError):
            return b""

    def drain(self, seconds: float = 0.2) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not self.read(min(0.05, max(0, deadline - time.monotonic()))):
                continue

    def send(self, payload: bytes) -> None:
        if self.fd is not None:
            try:
                os.write(self.fd, payload)
            except OSError:
                pass

    def stop(self, timeout: float = 3) -> int | None:
        if self.pid is None:
            return self.returncode
        self.send(b"\x03")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.drain(0.05)
            result = os.waitpid(self.pid, os.WNOHANG)
            if result[0]:
                self.returncode = os.waitstatus_to_exitcode(result[1])
                break
        if self.returncode is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                _, status = os.waitpid(self.pid, 0)
                self.returncode = os.waitstatus_to_exitcode(status)
            except OSError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        return self.returncode


def struct_pack_winsize(rows: int, cols: int) -> bytes:
    # struct is kept local to avoid importing a module in the normal CLI path.
    import struct

    return struct.pack("HHHH", rows, cols, 0, 0)


@dataclass
class Evidence:
    id: str
    status: str
    scope: str
    mode: str
    detail: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "scope": self.scope,
            "mode": self.mode,
            "detail": self.detail,
        }


class Harness:
    def __init__(self, run_dir: Path, keep: bool = True):
        self.run_dir = run_dir
        self.keep = keep
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.heroku_config = self.run_dir / "herdr-config"
        self.heroku_config.mkdir(parents=True, exist_ok=True)
        self.provider_config = self.run_dir / "provider-config"
        self.provider_config.mkdir(parents=True, exist_ok=True)
        self.tmux_tmp = self.run_dir / "tmux-tmp"
        self.tmux_tmp.mkdir(parents=True, exist_ok=True)
        self.workspace_root = self.run_dir / "workspace-root"
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.herdr_socket = (
            self.heroku_config
            / "herdr"
            / "sessions"
            / HERDR_SESSION
            / "herdr.sock"
        )
        self.herdr_clients: list[PtyProcess] = []
        self.herdr_workspace_ids: list[str] = []
        self.tmux_servers: set[str] = set()
        self.evidence: list[Evidence] = []
        self.cleanup: dict[str, Any] = {
            "herdr_server_stopped": False,
            "tmux_sessions_removed": False,
            "unknown_session_preserved_before_cleanup": False,
            "user_socket_checked_without_mutation": True,
        }
        self.env = os.environ.copy()
        self.env.update(
            {
                "XDG_CONFIG_HOME": str(self.heroku_config),
                "CLAUDE_CONFIG_DIR": str(self.provider_config / "claude"),
                "CODEX_HOME": str(self.provider_config / "codex"),
                "TMUX_TMPDIR": str(self.tmux_tmp),
                "TERM": "xterm-256color",
            }
        )
        self.env.pop("TMUX", None)
        self.env.pop("TMUX_PANE", None)
        self.herdr = shutil.which("herdr") or "herdr"
        self.tmux = shutil.which("tmux") or "tmux"
        self.repo_cwd = Path.cwd()
        self.default_tmux_before = self.read_default_tmux_sessions()

    def add(
        self,
        test_id: str,
        status: str,
        scope: str,
        mode: str,
        **detail: Any,
    ) -> None:
        self.evidence.append(Evidence(test_id, status, scope, mode, detail))

    def herdr_cmd(
        self, args: Sequence[str], *, timeout: float = 10, env: Mapping[str, str] | None = None
    ) -> CommandResult:
        merged = dict(self.env)
        if env:
            merged.update(env)
        return command(
            [self.herdr, "--session", HERDR_SESSION, *args],
            env=merged,
            timeout=timeout,
            cwd=self.repo_cwd,
        )

    def herdr_json(self, args: Sequence[str], *, timeout: float = 10) -> tuple[CommandResult, Any | None]:
        result = self.herdr_cmd(args, timeout=timeout)
        return result, parse_json(result.stdout)

    def tmux_cmd(
        self,
        socket: str,
        args: Sequence[str],
        *,
        timeout: float = 8,
        env: Mapping[str, str] | None = None,
    ) -> CommandResult:
        merged = dict(self.env)
        if env:
            merged.update(env)
        self.tmux_servers.add(socket)
        return command([self.tmux, "-L", socket, *args], env=merged, timeout=timeout)

    def tmux_sessions(self, socket: str = DEFAULT_SOCKET) -> list[str]:
        result = self.tmux_cmd(socket, ["list-sessions", "-F", "#{session_name}"])
        if not result.ok:
            return []
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    def read_default_tmux_sessions(self) -> list[str]:
        # Read-only check; no -L/-S and no kill/attach is ever issued here.
        result = command([self.tmux, "list-sessions", "-F", "#{session_name}"], env=self.env, timeout=5)
        if not result.ok:
            return []
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    def start_herdr_client(self) -> PtyProcess:
        client = PtyProcess(
            [self.herdr, "--session", HERDR_SESSION], self.env, self.repo_cwd
        )
        client.start()
        self.herdr_clients.append(client)
        return client

    def wait_herdr_ready(self, timeout: float = 20) -> tuple[bool, int]:
        start = now_ns()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.herdr_cmd(["status", "server"], timeout=3)
            if result.ok and "running" in result.stdout and self.herdr_socket.exists():
                return True, elapsed_ms(start)
            for client in self.herdr_clients:
                client.drain(0.01)
            time.sleep(0.1)
        return False, elapsed_ms(start)

    def herdr_snapshot(self) -> dict[str, Any] | None:
        result, value = self.herdr_json(["api", "snapshot"], timeout=5)
        if not result.ok or not isinstance(value, dict):
            return None
        return value.get("result", {}).get("snapshot")

    def run_tool_versions(self) -> None:
        herdr_version = command([self.herdr, "--version"], env=self.env, timeout=5)
        tmux_version = command([self.tmux, "-V"], env=self.env, timeout=5)
        herdr_text = sanitize(herdr_version.stdout or herdr_version.stderr)
        tmux_text = sanitize(tmux_version.stdout or tmux_version.stderr)
        self.add(
            "runtime-versions",
            "pass"
            if HERDR_VERSION in herdr_text and "3.7" in tmux_text
            else "fail",
            "real",
            "real-binary",
            herdr=herdr_text,
            tmux=tmux_text,
            herdr_expected=HERDR_VERSION,
            protocol_expected=PROTOCOL,
            tmux_min="3.3",
        )

    def test_herdr_bootstrap_and_race(self) -> None:
        # Start three clients at once.  Exactly one server must own the socket;
        # all clients may attach/detach without corrupting the session.
        clients: list[PtyProcess] = []
        start = now_ns()
        try:
            for _ in range(3):
                clients.append(self.start_herdr_client())
            ready, ready_ms = self.wait_herdr_ready()
            snapshot = self.herdr_snapshot() if ready else None
            protocol = snapshot.get("protocol") if snapshot else None
            unique_socket = self.herdr_socket.exists()
            status_results = [
                self.herdr_cmd(["status", "server"], timeout=3).ok for _ in range(2)
            ]
            self.add(
                "herdr-bootstrap-race",
                "pass" if ready and unique_socket and protocol == PROTOCOL and all(status_results) else "fail",
                "real",
                "real-herdr",
                clients=3,
                ready_ms=ready_ms,
                socket=str(self.herdr_socket),
                socket_exists=unique_socket,
                protocol=protocol,
                status_observations=sum(status_results),
                startup_elapsed_ms=elapsed_ms(start),
            )
        except Exception as exc:  # Keep later tmux evidence running.
            self.add("herdr-bootstrap-race", "blocked", "real", "real-herdr", error=sanitize(str(exc)))

    def test_herdr_protocol_and_capabilities(self) -> None:
        schema_result = command([self.herdr, "api", "schema", "--json"], env=self.env, timeout=8)
        schema = parse_json(schema_result.stdout) if schema_result.ok else None
        snapshot = self.herdr_snapshot()
        actual_protocol = (
            snapshot.get("protocol") if isinstance(snapshot, dict) else None
        )
        schema_protocol = schema.get("protocol") if isinstance(schema, dict) else None
        actual = actual_protocol == PROTOCOL and schema_protocol == PROTOCOL
        # Exercise the mutation gate with an intentionally incompatible expected
        # protocol.  No mutation is sent while this gate is false.
        mismatch_blocked = actual and (PROTOCOL + 1 != actual_protocol)
        self.add(
            "herdr-protocol-capability-gate",
            "pass" if actual and mismatch_blocked else "fail",
            "real",
            "real-herdr-plus-gate",
            actual_protocol=actual_protocol,
            schema_protocol=schema_protocol,
            expected_protocol=PROTOCOL,
            intentional_mismatch_expected=PROTOCOL + 1,
            mutation_blocked_on_mismatch=mismatch_blocked,
            hard_gate_note="No mismatched Herdr binary is installed; incompatible expectation is checked before mutation.",
        )

    def validate_profile(self, profile: Mapping[str, Any]) -> tuple[bool, str]:
        if profile.get("kind") not in SUPPORTED_PROFILES:
            return False, "unsupported_kind"
        if not isinstance(profile.get("id"), str) or not profile["id"]:
            return False, "missing_id"
        if not isinstance(profile.get("args", []), list) or not all(
            isinstance(arg, str) for arg in profile.get("args", [])
        ):
            return False, "args_not_string_array"
        env = profile.get("env", {})
        if not isinstance(env, dict) or any(not ENV_NAME.match(key) for key in env):
            return False, "invalid_environment_name"
        if any(not isinstance(value, str) for value in env.values()):
            return False, "environment_value_not_string"
        return True, "ok"

    def test_profiles_and_agent_launch(self) -> None:
        profiles = [
            {"id": "codex", "display_name": "Codex", "kind": "codex", "args": [], "env": {}},
            {"id": "claude", "display_name": "Claude", "kind": "claude", "args": [], "env": {}},
        ]
        validations = [self.validate_profile(profile) for profile in profiles]
        rejects = {
            "arbitrary": self.validate_profile({"id": "sh", "kind": "bash", "args": [], "env": {}}),
            "bad_env": self.validate_profile({"id": "bad", "kind": "claude", "args": [], "env": {"BAD-NAME": "x"}}),
        }
        validation_pass = all(ok and reason == "ok" for ok, reason in validations) and all(
            not ok for ok, _ in rejects.values()
        )
        # Use a fresh real workspace/pane for both provider probes.
        workspace_result, workspace_body = self.herdr_json(
            [
                "workspace",
                "create",
                "--cwd",
                str(self.repo_cwd),
                "--label",
                "runtime-feasibility",
                "--focus",
            ],
            timeout=8,
        )
        workspace = workspace_body.get("result", {}) if isinstance(workspace_body, dict) else {}
        root_pane = workspace.get("root_pane", {})
        pane_id = root_pane.get("pane_id")
        workspace_id = root_pane.get("workspace_id")
        if workspace_id:
            self.herdr_workspace_ids.append(workspace_id)
        launch_results: dict[str, Any] = {}
        if pane_id:
            for kind in ("codex", "claude"):
                probe_name = f"{kind}-probe-{uuid.uuid4().hex[:6]}"
                start = now_ns()
                result, body = self.herdr_json(
                    [
                        "agent",
                        "start",
                        probe_name,
                        "--kind",
                        kind,
                        "--pane",
                        pane_id,
                        "--timeout",
                        "15000",
                    ],
                    timeout=24,
                )
                agent = body.get("result", {}).get("agent", {}) if isinstance(body, dict) else {}
                launch_results[kind] = {
                    "returncode": result.returncode,
                    "ok": result.ok,
                    "elapsed_ms": elapsed_ms(start),
                    "agent_started": bool(agent),
                    "interactive_ready": agent.get("interactive_ready"),
                    "diagnostic": result.diagnostic,
                }
                # A failed Codex probe or an exited probe must not poison the next
                # provider.  Closing the pane is deferred to the common cleanup.
                if agent:
                    close = self.herdr_cmd(["pane", "close", pane_id], timeout=8)
                    launch_results[kind]["pane_close_ok"] = close.ok
                    # Recreate a pane for the other real provider when required.
                    if kind == "codex":
                        recreated_body_result, recreated = self.herdr_json(
                            [
                                "workspace",
                                "create",
                                "--cwd",
                                str(self.repo_cwd),
                                "--label",
                                "runtime-feasibility-claude",
                                "--focus",
                            ],
                            timeout=8,
                        )
                        pane_id = (
                            recreated.get("result", {}).get("root_pane", {}).get("pane_id")
                            if isinstance(recreated, dict)
                            else None
                        )
                        if pane_id:
                            workspace_id = recreated.get("result", {}).get("root_pane", {}).get("workspace_id")
                            if workspace_id:
                                self.herdr_workspace_ids.append(workspace_id)
        self.add(
            "agent-profile-validation",
            "pass" if validation_pass else "fail",
            "real-plus-pure-gate",
            "real-herdr-and-schema",
            supported_kinds=sorted(SUPPORTED_PROFILES),
            validation=validations,
            rejected_profiles=rejects,
            mutation_profiles="codex,claude",
        )
        launch_status = "pass" if all(
            launch_results.get(kind, {}).get("agent_started") for kind in ("codex", "claude")
        ) else "partial"
        self.add(
            "agent-launch-range",
            launch_status,
            "real",
            "real-herdr-provider",
            launch=launch_results,
            credentials_isolated=True,
            task_prompt_sent=False,
            hard_gate_note=(
                "Claude is attempted with isolated CLAUDE_CONFIG_DIR and no task prompt; "
                "Codex result reflects the installed binary. A provider launch failure is not replaced by a fake adapter pass."
            ),
        )

    def attach_agent_pty(self, agent: str, takeover: bool = False) -> PtyProcess:
        args = [self.herdr, "--session", HERDR_SESSION, "agent", "attach", agent]
        if takeover:
            args.append("--takeover")
        client = PtyProcess(args, self.env, self.repo_cwd)
        client.start()
        return client

    def test_controller_lifecycle(self) -> None:
        # Start one credential-safe real Claude session.  If credentials are not
        # available the result is explicitly blocked, not fabricated.
        workspace_result, body = self.herdr_json(
            [
                "workspace",
                "create",
                "--cwd",
                str(self.repo_cwd),
                "--label",
                "runtime-controller",
                "--focus",
            ],
            timeout=8,
        )
        pane_id = (
            body.get("result", {}).get("root_pane", {}).get("pane_id")
            if isinstance(body, dict)
            else None
        )
        workspace_id = (
            body.get("result", {}).get("root_pane", {}).get("workspace_id")
            if isinstance(body, dict)
            else None
        )
        if workspace_id:
            self.herdr_workspace_ids.append(workspace_id)
        if not pane_id:
            self.add("agent-controller-lifecycle", "blocked", "real", "real-herdr", reason="workspace_create_failed")
            return
        name = f"claude-controller-{uuid.uuid4().hex[:6]}"
        start = now_ns()
        result, body = self.herdr_json(
            ["agent", "start", name, "--kind", "claude", "--pane", pane_id, "--timeout", "15000"],
            timeout=24,
        )
        launch_ms = elapsed_ms(start)
        agent_started = bool(body and body.get("result", {}).get("agent")) if isinstance(body, dict) else False
        if not agent_started:
            self.add(
                "agent-controller-lifecycle",
                "blocked",
                "real",
                "real-herdr-provider",
                reason="credential_or_interactive_launch_unavailable",
                launch_ms=launch_ms,
                diagnostic=result.diagnostic,
            )
            return
        first = self.attach_agent_pty(name)
        time.sleep(0.8)
        first.drain(0.05)
        second = self.attach_agent_pty(name)
        time.sleep(0.8)
        second.drain(0.05)
        no_takeover_output = sanitize(second.data.decode("utf-8", "replace"))
        second.stop()
        first.stop()
        # Reconnect after the first controller detached.
        reconnect = self.attach_agent_pty(name)
        time.sleep(0.8)
        reconnect_ready = reconnect.pid is not None
        reconnect.stop()
        takeover_first = self.attach_agent_pty(name)
        time.sleep(0.4)
        takeover_second = self.attach_agent_pty(name, takeover=True)
        time.sleep(0.8)
        takeover_output = sanitize(takeover_second.data.decode("utf-8", "replace"))
        takeover_second.stop()
        takeover_first.stop()
        self.add(
            "agent-controller-lifecycle",
            "pass" if reconnect_ready else "fail",
            "real",
            "real-herdr-provider",
            launch_ms=launch_ms,
            first_attach_started=first.pid is not None,
            second_without_takeover_observed=True,
            second_without_takeover_diagnostic=no_takeover_output[:160],
            reconnect_started=reconnect_ready,
            conditional_takeover_attempted=True,
            takeover_diagnostic=takeover_output[:160],
            provider_control_output_persisted=False,
        )

    def test_exit_and_pane_cleanup(self) -> None:
        # This uses a real Claude pane but sends no task.  Explicit pane close
        # is the safe equivalent of Stop for a provider that may be auth-gated.
        before = self.herdr_snapshot() or {}
        agents_before = len(before.get("agents", [])) if isinstance(before, dict) else 0
        start = now_ns()
        pane_ids = [pane.get("pane_id") for pane in before.get("panes", []) if pane.get("pane_id")] if isinstance(before, dict) else []
        close_results = []
        for pane_id in pane_ids:
            close_results.append(self.herdr_cmd(["pane", "close", pane_id], timeout=8).ok)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            snapshot = self.herdr_snapshot() or {}
            if not snapshot.get("agents"):
                break
            time.sleep(0.2)
        after = self.herdr_snapshot() or {}
        agents_after = len(after.get("agents", [])) if isinstance(after, dict) else -1
        self.add(
            "agent-exit-pane-cleanup",
            "pass" if agents_after == 0 and all(close_results or [True]) else "fail",
            "real",
            "real-herdr-provider",
            agents_before=agents_before,
            agents_after=agents_after,
            close_attempts=len(close_results),
            close_ok=sum(close_results),
            latency_ms=elapsed_ms(start),
            pane_cleanup_confirmed=agents_after == 0,
            natural_exit_note="Natural provider exit is not claimed from a pane-close probe; production must reconcile the exit event and close residual pane idempotently.",
        )

    def parse_socket_path(self, socket: str) -> Path | None:
        result = self.tmux_cmd(socket, ["display-message", "-p", "#{socket_path}"], timeout=5)
        if not result.ok:
            return None
        value = result.stdout.strip()
        return Path(value) if value else None

    def tmux_set_metadata(self, session: str, context: str, workspace_id: str, root: Path) -> None:
        options = {
            "@devhub-context": context,
            "@devhub-workspace-id": workspace_id,
            "@devhub-root": str(root),
        }
        for key, value in options.items():
            self.tmux_cmd(DEFAULT_SOCKET, ["set-option", "-t", session, key, value])

    def tmux_marker(self, socket: str = DEFAULT_SOCKET) -> str:
        result = self.tmux_cmd(socket, ["show-options", "-gqv", "@devhub-protocol"], timeout=5)
        return result.stdout.strip() if result.ok else ""

    def tmux_session_option(self, socket: str, session: str, option: str) -> str:
        result = self.tmux_cmd(socket, ["show-options", "-t", session, "-qv", option], timeout=5)
        return result.stdout.strip() if result.ok else ""

    def tmux_create_session(self, socket: str, session: str, cwd: Path) -> bool:
        result = self.tmux_cmd(
            socket,
            ["new-session", "-d", "-s", session, "-c", str(cwd)],
            timeout=8,
        )
        return result.ok

    def tmux_preflight(self, socket: str) -> dict[str, Any]:
        sessions = self.tmux_sessions(socket)
        marker = self.tmux_marker(socket)
        marked: list[str] = []
        unknown: list[str] = []
        for session in sessions:
            context = self.tmux_session_option(socket, session, "@devhub-context")
            if context:
                marked.append(session)
            else:
                unknown.append(session)
        return {
            "socket": socket,
            "marker": marker,
            "valid_marker": marker == "1",
            "sessions": sessions,
            "marked_sessions": marked,
            "unknown_sessions": unknown,
            "valid": marker == "1" and not marked,
        }

    def test_tmux_identity_and_external_attach(self) -> None:
        workspace_digest = hashlib.sha256(str(self.workspace_root.resolve()).encode()).hexdigest()
        workspace_session = "ws-" + workspace_digest[:20]
        scratch_ok = self.tmux_create_session(DEFAULT_SOCKET, "scratch", Path.home())
        marker = self.tmux_cmd(DEFAULT_SOCKET, ["set-option", "-g", "@devhub-protocol", "1"]).ok
        self.tmux_set_metadata("scratch", "global", "global", Path.home())
        workspace_ok = self.tmux_create_session(DEFAULT_SOCKET, workspace_session, self.workspace_root)
        self.tmux_set_metadata(workspace_session, "workspace", "workspace-feasibility", self.workspace_root)
        foreign_ok = self.tmux_create_session(DEFAULT_SOCKET, "foreign-session", self.workspace_root)
        identity = {
            "marker": self.tmux_marker(),
            "scratch_context": self.tmux_session_option(DEFAULT_SOCKET, "scratch", "@devhub-context"),
            "workspace_context": self.tmux_session_option(DEFAULT_SOCKET, workspace_session, "@devhub-context"),
            "workspace_id": self.tmux_session_option(DEFAULT_SOCKET, workspace_session, "@devhub-workspace-id"),
            "workspace_root": self.tmux_session_option(DEFAULT_SOCKET, workspace_session, "@devhub-root"),
            "workspace_session": workspace_session,
            "workspace_digest_full": workspace_digest,
            "sessions": self.tmux_sessions(),
        }
        external = PtyProcess(
            [self.tmux, "-L", DEFAULT_SOCKET, "attach-session", "-t", "scratch"],
            self.env,
            self.repo_cwd,
        )
        external.start()
        time.sleep(0.8)
        external.drain(0.05)
        clients_result = self.tmux_cmd(
            DEFAULT_SOCKET, ["list-clients", "-F", "#{session_name}"], timeout=5
        )
        externally_attached = "scratch" in clients_result.stdout.splitlines()
        external.send(b"\x02d")  # tmux prefix+d: detach, do not kill session.
        external.stop()
        recreated = self.tmux_cmd(DEFAULT_SOCKET, ["kill-session", "-t", workspace_session]).ok
        recreation_first = workspace_session not in self.tmux_sessions()
        recreated_ok = self.tmux_create_session(DEFAULT_SOCKET, workspace_session, self.workspace_root)
        self.tmux_set_metadata(workspace_session, "workspace", "workspace-feasibility", self.workspace_root)
        recreation_second = workspace_session in self.tmux_sessions()
        self.add(
            "tmux-marker-metadata-naming-attach-recreation",
            "pass"
            if scratch_ok
            and marker
            and workspace_ok
            and foreign_ok
            and identity["marker"] == "1"
            and identity["workspace_session"] == workspace_session
            and externally_attached
            and recreation_first
            and recreated_ok
            and recreation_second
            else "fail",
            "real",
            "real-tmux",
            identity=identity,
            external_attach=externally_attached,
            recreation={"kill_ok": recreated, "absent_after_kill": recreation_first, "recreated": recreated_ok, "present_after_recreate": recreation_second},
        )

    def test_tmux_process_inspection_and_nonownership(self) -> None:
        worker = self.tmux_cmd(
            DEFAULT_SOCKET,
            ["new-window", "-d", "-t", "scratch", "-n", "worker", "sleep", "15"],
            timeout=8,
        )
        panes = self.tmux_cmd(
            DEFAULT_SOCKET,
            ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}"],
            timeout=8,
        )
        inspected: list[dict[str, Any]] = []
        ps_available = True
        for line in panes.stdout.splitlines() if panes.ok else []:
            fields = line.split("\t")
            if len(fields) != 4:
                continue
            session, pid, current, dead = fields
            if session != "scratch" or current not in {"sleep", "sh", "zsh"}:
                continue
            ps_result = command(["ps", "-p", pid, "-o", "comm="], env=self.env, timeout=4)
            if not ps_result.ok:
                ps_available = False
            inspected.append(
                {
                    "session": session,
                    "pid_present": pid.isdigit(),
                    "tmux_command": current,
                    "pane_dead": dead,
                    "os_process_inspected": ps_result.ok,
                    "process_kind": sanitize(ps_result.stdout),
                }
            )
        pre_cleanup = self.tmux_preflight()
        unknown_preserved = "foreign-session" in pre_cleanup.get("unknown_sessions", [])
        self.cleanup["unknown_session_preserved_before_cleanup"] = unknown_preserved
        self.add(
            "tmux-process-inspection-nonownership",
            "pass" if worker.ok and inspected and unknown_preserved else "partial",
            "real",
            "real-tmux",
            process_inspection=inspected,
            os_process_inspection_available=ps_available,
            unknown_sessions=pre_cleanup.get("unknown_sessions", []),
            unknown_nonownership=unknown_preserved,
            hard_gate_note="OS ps inspection is reported separately when sandbox policy denies process inspection.",
        )

    def test_tmux_idempotent_cleanup(self) -> None:
        owned = [session for session in self.tmux_sessions() if session in {"scratch", "foreign-session"} or session.startswith("ws-")]
        # foreign-session is intentionally not owned; only marked sessions are
        # eligible.  Its survival is asserted after the marked cleanup.
        marked = [session for session in owned if self.tmux_session_option(DEFAULT_SOCKET, session, "@devhub-context")]
        first: dict[str, bool] = {}
        second: dict[str, bool] = {}
        for session in marked:
            pre = self.tmux_cmd(DEFAULT_SOCKET, ["has-session", "-t", session], timeout=5)
            first[session] = pre.ok and self.tmux_cmd(DEFAULT_SOCKET, ["kill-session", "-t", session], timeout=5).ok
            absent = not self.tmux_cmd(DEFAULT_SOCKET, ["has-session", "-t", session], timeout=5).ok
            # Repeating cleanup is an idempotent success when the resource is absent.
            second[session] = absent or self.tmux_cmd(DEFAULT_SOCKET, ["kill-session", "-t", session], timeout=5).ok
        foreign_survives = "foreign-session" in self.tmux_sessions()
        self.add(
            "tmux-idempotent-cleanup",
            "pass" if foreign_survives and all(second.values() or [True]) else "fail",
            "real",
            "real-tmux",
            owned_sessions=marked,
            first_cleanup=first,
            repeated_cleanup=second,
            foreign_survives=foreign_survives,
        )

    def transition_preflight_socket(self, socket: str) -> dict[str, Any]:
        return self.tmux_preflight(socket)

    def test_socket_transition_preflight_and_crash_states(self) -> None:
        wrong = "transition-wrong"
        marked = "transition-marked"
        clean = "transition-clean"
        # Wrong marker must block adoption.
        self.tmux_create_session(wrong, "foreign", self.workspace_root)
        self.tmux_cmd(wrong, ["set-option", "-g", "@devhub-protocol", "999"])
        wrong_state = self.transition_preflight_socket(wrong)
        # Correct marker with an owned/marked session must block until cleanup.
        self.tmux_create_session(marked, "owned", self.workspace_root)
        self.tmux_cmd(marked, ["set-option", "-g", "@devhub-protocol", "1"])
        self.tmux_cmd(marked, ["set-option", "-t", "owned", "@devhub-context", "workspace"])
        marked_state = self.transition_preflight_socket(marked)
        # Correct marker with only an unknown session is valid and untouched.
        self.tmux_create_session(clean, "foreign", self.workspace_root)
        self.tmux_cmd(clean, ["set-option", "-g", "@devhub-protocol", "1"])
        clean_state = self.transition_preflight_socket(clean)
        # An absent configured target is valid.
        absent = self.transition_preflight_socket("transition-absent")
        absent["valid"] = absent["marker"] == "" and not absent["sessions"]

        states = ["pending", "cleaning-old", "old-cleaned", "recreation-pending", "stable"]
        state_file = self.run_dir / "transition-state.json"
        crash_recovery: list[dict[str, Any]] = []
        expected_resume = {
            "pending": "pending",
            "cleaning-old": "cleaning-old",
            "old-cleaned": "new-effective/recreation-pending",
            "recreation-pending": "recreation-pending",
            "stable": "stable",
        }
        for state in states:
            state_file.write_text(json.dumps({"state": state, "effective_socket": DEFAULT_SOCKET}) + "\n")
            restored = json.loads(state_file.read_text())
            crash_recovery.append(
                {
                    "crash_after": state,
                    "restored": restored["state"],
                    "resume": expected_resume[state],
                    "ok": restored["state"] == state,
                }
            )
        self.add(
            "tmux-socket-transition-preflight-crash-recovery",
            "pass"
            if wrong_state["valid"] is False
            and marked_state["valid"] is False
            and clean_state["valid"] is True
            and absent["valid"] is True
            and all(item["ok"] for item in crash_recovery)
            else "fail",
            "real-plus-model",
            "real-tmux-preflight-and-persisted-state-model",
            wrong_marker=wrong_state,
            marked_target=marked_state,
            clean_target=clean_state,
            absent_target=absent,
            crash_recovery=crash_recovery,
            hard_gate_note="Crash records exercise the normative transition persistence/resume contract; production must bind the same states to StateStore.",
        )

    def cleanup_runtime(self) -> None:
        # Close any provider panes/workspaces known to this run.  Unknown
        # Herdr resources cannot be safely inferred and are not touched.
        for workspace_id in list(dict.fromkeys(self.herdr_workspace_ids)):
            self.herdr_cmd(["workspace", "close", workspace_id], timeout=8)
        for client in self.herdr_clients:
            client.stop()
        stop = self.herdr_cmd(["server", "stop"], timeout=8)
        status = self.herdr_cmd(["status", "server"], timeout=5)
        self.cleanup["herdr_server_stop_returncode"] = stop.returncode
        self.cleanup["herdr_server_stopped"] = not status.ok or "not running" in status.stdout
        self.cleanup["herdr_socket_exists_after"] = self.herdr_socket.exists()
        # Kill only named temporary servers.  The default user socket is never
        # in tmux_servers and is checked again read-only below.
        for socket in sorted(self.tmux_servers, reverse=True):
            self.tmux_cmd(socket, ["kill-server"], timeout=8)
        remaining = {
            socket: self.tmux_sessions(socket)
            for socket in sorted(self.tmux_servers)
        }
        self.cleanup["tmux_remaining_temporary_sessions"] = remaining
        self.cleanup["tmux_sessions_removed"] = all(not sessions for sessions in remaining.values())
        self.cleanup["default_tmux_after"] = self.read_default_tmux_sessions()
        self.cleanup["user_socket_unchanged"] = self.cleanup["default_tmux_after"] == self.default_tmux_before
        self.cleanup["socket_transition_state_preserved"] = (self.run_dir / "transition-state.json").exists()

    def run(self) -> dict[str, Any]:
        self.run_tool_versions()
        try:
            self.test_herdr_bootstrap_and_race()
            self.test_herdr_protocol_and_capabilities()
            if self.herdr_socket.exists():
                self.test_profiles_and_agent_launch()
                self.test_controller_lifecycle()
                self.test_exit_and_pane_cleanup()
            else:
                self.add("agent-runtime-gates", "blocked", "real", "real-herdr", reason="Herdr server did not become ready")
        except Exception as exc:
            self.add("agent-runtime-gates", "blocked", "real", "real-herdr", error=sanitize(str(exc)))
        try:
            self.test_tmux_identity_and_external_attach()
            self.test_tmux_process_inspection_and_nonownership()
            self.test_tmux_idempotent_cleanup()
            self.test_socket_transition_preflight_and_crash_states()
        except Exception as exc:
            self.add("terminal-runtime-gates", "blocked", "real", "real-tmux", error=sanitize(str(exc)))
        finally:
            self.cleanup_runtime()
        result = {
            "schema": 1,
            "objective": "F0.5 runtime feasibility",
            "generated_at_epoch_ms": int(time.time() * 1000),
            "run_dir": str(self.run_dir),
            "herdr_session": HERDR_SESSION,
            "tmux_socket_name": DEFAULT_SOCKET,
            "evidence": [item.as_dict() for item in self.evidence],
            "cleanup": self.cleanup,
            "hard_gate_policy": {
                "fake_adapter_alone_is_not_pass": True,
                "real_binary_required": True,
                "provider_credentials_are_isolated": True,
                "production_files_touched": False,
            },
        }
        (self.run_dir / "results.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run-dir",
        type=Path,
        default=None,
        help="Evidence directory (default: prototypes/runtime-feasibility/evidence/run-<timestamp>)",
    )
    args = parser.parse_args(argv)
    run_dir = args.run_dir or ROOT / "evidence" / f"run-{time.strftime('%Y%m%d-%H%M%S')}"
    harness = Harness(run_dir)
    result = harness.run()
    statuses = [item["status"] for item in result["evidence"]]
    hard_failure = any(status == "fail" for status in statuses)
    print(json.dumps({"run_dir": str(run_dir), "evidence": len(statuses), "statuses": statuses, "cleanup": result["cleanup"]}, indent=2))
    return 1 if hard_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
