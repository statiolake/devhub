#!/usr/bin/env python3
"""Run a content-free raw Herdr 16-agent preflight for Q5.2.

This deliberately bypasses DevHub's adapter while using the same deterministic
executables, shell startup files, private HOME, and Herdr config as q5-native.
It reports only launch index, stage, and stable Herdr error categories.
"""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SESSION = "devhub-session"
BASE_SUBSCRIPTIONS = [
    {"type": "workspace.created"},
    {"type": "workspace.updated"},
    {"type": "workspace.closed"},
    {"type": "tab.created"},
    {"type": "tab.closed"},
    {"type": "pane.created"},
    {"type": "pane.updated"},
    {"type": "pane.closed"},
    {"type": "pane.exited"},
    {"type": "pane.agent_detected"},
]


def _q5_module():
    spec = importlib.util.spec_from_file_location("q5_native", ROOT / "scripts" / "q5-native.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("q5_fixture_module_unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _call(socket_path: Path, method: str, params: dict) -> dict:
    request = (json.dumps({"id": method, "method": method, "params": params}) + "\n").encode()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(str(socket_path))
        sock.sendall(request)
        data = bytearray()
        while not data.endswith(b"\n"):
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("herdr_response_closed")
            data.extend(chunk)
            if len(data) > 512 * 1024:
                raise RuntimeError("herdr_response_oversized")
    response = json.loads(data)
    if "error" in response:
        error = response["error"]
        code = error.get("code") if isinstance(error, dict) else None
        raise RuntimeError(f"provider_{code or 'rejected'}")
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("herdr_result_invalid")
    return result


def _wait_for(path: Path, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if path.exists():
            return
        if process.poll() is not None:
            raise RuntimeError("herdr_server_exited")
        time.sleep(0.05)
    raise RuntimeError("herdr_socket_timeout")


def _open_subscription(socket_path: Path, subscriptions: list[dict]) -> socket.socket:
    request = (
        json.dumps(
            {
                "id": "q5-raw-subscription",
                "method": "events.subscribe",
                "params": {"subscriptions": subscriptions},
            }
        )
        + "\n"
    ).encode()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(5)
    try:
        sock.connect(str(socket_path))
        sock.sendall(request)
        data = bytearray()
        while not data.endswith(b"\n"):
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("provider_subscription_closed")
            data.extend(chunk)
            if len(data) > 512 * 1024:
                raise RuntimeError("provider_subscription_oversized")
        response = json.loads(data)
        if "error" in response:
            error = response["error"]
            code = error.get("code") if isinstance(error, dict) else None
            raise RuntimeError(f"provider_{code or 'subscription_rejected'}")
        result = response.get("result")
        if not isinstance(result, dict) or result.get("type") != "subscription_started":
            raise RuntimeError("provider_subscription_not_started")
        return sock
    except BaseException:
        sock.close()
        raise


def main() -> int:
    q5 = _q5_module()
    herdr = Path(os.environ.get("DEVHUB_HERDR_BIN", "/opt/homebrew/bin/herdr"))
    launches = 0
    stage = "setup"
    subscriptions: list[socket.socket] = []
    result: dict[str, object] = {
        "status": "blocked",
        "launches": 0,
        "stage": stage,
        "error_class": "preflight_incomplete",
    }
    exit_code = 1
    owner = q5._q5_owned_fixture_home("dh-q5-raw-")
    fixture = None
    home = Path()
    pid_dir = Path()
    commands = None
    server: subprocess.Popen[bytes] | None = None
    try:
        fixture = owner.__enter__()
        home = fixture.home
        pid_dir = fixture.pid_dir
        commands = fixture.commands
        if commands is None:
            raise RuntimeError("q5_agent_executable_unavailable")
        trace = home / ".q5-agent-trace"
        config = home / ".config"
        api_socket = config / "herdr" / "sessions" / SESSION / "herdr.sock"
        env = os.environ.copy()
        env.update(
            {
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(config),
                "XDG_STATE_HOME": str(home / ".state"),
                "XDG_DATA_HOME": str(home / ".data"),
                "DEVHUB_HERDR_TRACE_FILE": str(trace),
                "DEVHUB_HERDR_PID_DIR": str(pid_dir),
                "HERDR_CONFIG_PATH": str(config / "herdr" / "config.toml"),
                "PATH": f"{commands}:/opt/homebrew/bin:/usr/bin:/bin",
            }
        )
        server = subprocess.Popen(
            [str(herdr), "--session", SESSION, "server"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        fixture.app_pid = server.pid
        fixture.active_process = q5._ProcessHandle(server.pid, server)
        fixture.stop_herdr_first = True
        _wait_for(api_socket, server)
        stage = "ping"
        _call(api_socket, "ping", {})
        stage = "base_subscription"
        subscriptions.append(_open_subscription(api_socket, BASE_SUBSCRIPTIONS))
        for index in range(16):
            stage = "workspace_create"
            workspace = home / ".q5-raw" / f"workspace-{index + 1:02}"
            workspace.mkdir(parents=True, exist_ok=True)
            kind = "codex" if index % 2 == 0 else "claude"
            created = _call(
                api_socket,
                "workspace.create",
                {
                    "cwd": str(workspace),
                    "focus": False,
                    "label": f"q5-raw-{index + 1:02}",
                    "env": {
                        "HERDR_AGENT": kind,
                        "DEVHUB_HERDR_TRACE_FILE": str(trace),
                        "DEVHUB_HERDR_PID_DIR": str(pid_dir),
                        "PATH": env["PATH"],
                    },
                },
            )
            pane = created.get("root_pane", {}).get("pane_id")
            if not isinstance(pane, str):
                raise RuntimeError("provider_mapping_invalid")
            stage = "agent_start"
            _call(
                api_socket,
                "agent.start",
                {
                    "name": f"q5-raw-{index + 1:02}",
                    "kind": kind,
                    "pane_id": pane,
                    "args": ["--q5-deterministic"],
                    "timeout_ms": 5000,
                },
            )
            launches += 1
            stage = "agent_evidence"
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                pids = list(pid_dir.glob("*.pid"))
                if len(pids) >= launches:
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError("deterministic_agent_not_live")
            stage = "pane_subscription"
            subscriptions.append(
                _open_subscription(
                    api_socket,
                    [{"type": "pane.agent_status_changed", "pane_id": pane}],
                )
            )
        result = {
            "status": "covered",
            "launches": launches,
            "last_stage": "agent_evidence",
        }
        exit_code = 0
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        result = {
            "status": "blocked",
            "launches": launches,
            "stage": stage,
            "error_class": str(exc).split(" ", 1)[0],
        }
    finally:
        for subscription in reversed(subscriptions):
            try:
                subscription.close()
            except OSError:
                pass
        try:
            if fixture is not None:
                owner.__exit__(None, None, None)
        except OSError as error:
            result = {
                "status": "blocked",
                "launches": launches,
                "stage": "cleanup",
                "error_class": str(error),
            }
            exit_code = 1
    print(json.dumps(result))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
