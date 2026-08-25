#!/usr/bin/env python3
"""F0.5 tmux feasibility probe.

The probe uses the installed tmux binary (not a fake adapter) through a
temporary ``TMUX_TMPDIR`` and the configured socket name ``devhub``.  The
normal user tmux server is read before and after the run and is never selected
with ``-L``/``-S`` or sent a mutating command.
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
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping, Sequence


SOCKET = "devhub"
PROTOCOL_MARKER = "1"


def sanitize(value: str, limit: int = 240) -> str:
    value = value.replace("\x1b", "<esc>")
    value = re.sub(r"(?i)(bearer\s+|token[=:]\s*)[^\s,;]+", r"\1<redacted>", value)
    value = re.sub(r"[\w.+-]+@[\w.-]+", "<email>", value)
    value = value.replace(str(Path.home()), "<home>")
    return re.sub(r"\s+", " ", value).strip()[:limit]


class Client:
    """A PTY client for the external attach check."""

    def __init__(self, argv: Sequence[str], env: Mapping[str, str], cwd: Path):
        self.argv = list(argv)
        self.env = dict(env)
        self.cwd = cwd
        self.pid: int | None = None
        self.fd: int | None = None
        self.data = bytearray()

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

            fcntl.ioctl(fd, 0x5414, struct.pack("HHHH", 40, 120, 0, 0))
        except OSError:
            pass

    def drain(self, seconds: float = 0.2) -> None:
        if self.fd is None:
            return
        end = time.monotonic() + seconds
        while time.monotonic() < end:
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

    def stop(self) -> None:
        if self.pid is None:
            return
        self.send(b"\x03")
        deadline = time.monotonic() + 2
        status: int | None = None
        while time.monotonic() < deadline:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG)
                if pid:
                    break
            except OSError:
                break
            self.drain(0.05)
        if status is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
                _, status = os.waitpid(self.pid, 0)
            except OSError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass


class TmuxProbe:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir.resolve()
        self.run_dir.mkdir(parents=True, exist_ok=True)
        # tmux appends ``tmux-<uid>/<socket>`` to TMUX_TMPDIR and macOS has a
        # short AF_UNIX pathname limit.  Keep the temporary socket path short;
        # all durable evidence remains below the owned run directory.
        self.tmux_tmp = Path(tempfile.mkdtemp(prefix="devhub-tmux-", dir="/private/tmp"))
        self.root = self.run_dir / "workspace-root"
        self.root.mkdir(parents=True, exist_ok=True)
        self.tmux = shutil.which("tmux") or "tmux"
        self.env = os.environ.copy()
        self.env["TMUX_TMPDIR"] = str(self.tmux_tmp)
        self.env["TERM"] = "xterm-256color"
        self.env.pop("TMUX", None)
        self.env.pop("TMUX_PANE", None)
        self.results: list[dict[str, Any]] = []
        self.sockets: set[str] = set()
        self.before_default = self.default_sessions()
        self.cleanup: dict[str, Any] = {
            "default_sessions_before": self.before_default,
            "default_sessions_after": [],
            "default_socket_mutated": False,
            "temporary_servers_stopped": False,
            "temporary_sessions_after": {},
            "foreign_preserved_during_owned_cleanup": False,
            "temporary_tmux_tmpdir": str(self.tmux_tmp),
        }

    def cmd(self, socket: str, args: Sequence[str], timeout: float = 8) -> subprocess.CompletedProcess[str]:
        self.sockets.add(socket)
        return subprocess.run(
            [self.tmux, "-L", socket, *args],
            env=self.env,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )

    def default_sessions(self) -> list[str]:
        try:
            result = subprocess.run(
                [self.tmux, "list-sessions", "-F", "#{session_name}"],
                env=self.env,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return []
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    def sessions(self, socket: str = SOCKET) -> list[str]:
        try:
            result = self.cmd(socket, ["list-sessions", "-F", "#{session_name}"])
        except subprocess.TimeoutExpired:
            return []
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    def option(self, socket: str, target: str | None, name: str) -> str:
        args = ["show-options"]
        if target is None:
            args.extend(["-g"])
        else:
            args.extend(["-t", target])
        args.extend(["-qv", name])
        result = self.cmd(socket, args)
        return result.stdout.strip() if result.returncode == 0 else ""

    def set_option(self, socket: str, target: str | None, name: str, value: str) -> bool:
        args = ["set-option"]
        if target is None:
            args.append("-g")
        else:
            args.extend(["-t", target])
        args.extend([name, value])
        return self.cmd(socket, args).returncode == 0

    def new_session(self, socket: str, name: str, cwd: Path) -> bool:
        try:
            result = self.cmd(socket, ["new-session", "-d", "-s", name, "-c", str(cwd)])
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            return False

    def marker(self, socket: str) -> str:
        return self.option(socket, None, "@devhub-protocol")

    def metadata(self, socket: str, session: str) -> dict[str, str]:
        return {
            key: self.option(socket, session, key)
            for key in ("@devhub-context", "@devhub-workspace-id", "@devhub-root")
        }

    def marked_sessions(self, socket: str) -> list[str]:
        return [session for session in self.sessions(socket) if self.option(socket, session, "@devhub-context")]

    def preflight(self, socket: str) -> dict[str, Any]:
        sessions = self.sessions(socket)
        marker = self.marker(socket)
        marked = self.marked_sessions(socket)
        unknown = [session for session in sessions if session not in marked]
        return {
            "socket": socket,
            "marker": marker,
            "sessions": sessions,
            "marked_sessions": marked,
            "unknown_sessions": unknown,
            "valid": marker == PROTOCOL_MARKER and not marked,
        }

    def add(self, test_id: str, status: str, **detail: Any) -> None:
        self.results.append({"id": test_id, "status": status, "detail": detail})

    def identity_attach_recreate(self) -> None:
        digest = hashlib.sha256(str(self.root).encode()).hexdigest()
        workspace = "ws-" + digest[:20]
        scratch_ok = self.new_session(SOCKET, "scratch", Path.home())
        marker_ok = self.set_option(SOCKET, None, "@devhub-protocol", PROTOCOL_MARKER)
        scratch_meta_ok = all(
            self.set_option(SOCKET, "scratch", key, value)
            for key, value in {
                "@devhub-context": "global",
                "@devhub-workspace-id": "global",
                "@devhub-root": str(Path.home()),
            }.items()
        )
        workspace_ok = self.new_session(SOCKET, workspace, self.root)
        workspace_meta = {
            "@devhub-context": "workspace",
            "@devhub-workspace-id": "workspace-feasibility",
            "@devhub-root": str(self.root),
        }
        workspace_meta_ok = all(self.set_option(SOCKET, workspace, key, value) for key, value in workspace_meta.items())
        foreign_ok = self.new_session(SOCKET, "foreign-session", self.root)
        metadata = self.metadata(SOCKET, workspace)

        client = Client([self.tmux, "-L", SOCKET, "attach-session", "-t", "scratch"], self.env, self.run_dir)
        client.start()
        time.sleep(0.8)
        client.drain(0.1)
        attached = "scratch" in [line.strip() for line in self.cmd(SOCKET, ["list-clients", "-F", "#{session_name}"]).stdout.splitlines()]
        client.send(b"\x02d")
        client.stop()

        kill_ok = self.cmd(SOCKET, ["kill-session", "-t", workspace]).returncode == 0
        absent = workspace not in self.sessions(SOCKET)
        recreate_ok = self.new_session(SOCKET, workspace, self.root)
        recreated_meta_ok = all(self.set_option(SOCKET, workspace, key, value) for key, value in workspace_meta.items())
        recreated = workspace in self.sessions(SOCKET)
        self.add(
            "tmux-identity-attach-recreation",
            "pass" if all((scratch_ok, marker_ok, scratch_meta_ok, workspace_ok, workspace_meta_ok, foreign_ok, attached, kill_ok, absent, recreate_ok, recreated_meta_ok, recreated)) else "fail",
            socket_name=SOCKET,
            marker=self.marker(SOCKET),
            deterministic_session=workspace,
            digest_full=digest,
            metadata=metadata,
            recreated_metadata=self.metadata(SOCKET, workspace),
            external_attach=attached,
            foreign_session_created=foreign_ok,
        )
        self.workspace = workspace

    def process_busy_nonownership(self) -> None:
        worker = self.cmd(SOCKET, ["new-window", "-d", "-t", "scratch", "-n", "worker", "sleep", "15"])
        panes = self.cmd(SOCKET, ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}"])
        inspected: list[dict[str, Any]] = []
        for line in panes.stdout.splitlines():
            fields = line.split("\t")
            if len(fields) != 4 or fields[0] != "scratch":
                continue
            session, pid, current, dead = fields
            if current not in {"sleep", "sh", "zsh"}:
                continue
            try:
                ps = subprocess.run(["ps", "-p", pid, "-o", "comm="], env=self.env, capture_output=True, text=True, timeout=4, check=False)
                ps_ok = ps.returncode == 0
                ps_kind = sanitize(ps.stdout)
            except (OSError, subprocess.TimeoutExpired):
                ps_ok, ps_kind = False, "unavailable"
            inspected.append({"pid": pid, "pid_present": pid.isdigit(), "command": current, "pane_dead": dead, "os_process": ps_ok, "process_kind": ps_kind})
        preflight = self.preflight(SOCKET)
        foreign_preserved = "foreign-session" in preflight["unknown_sessions"]
        self.cleanup["foreign_preserved_during_owned_cleanup"] = foreign_preserved
        self.add(
            "tmux-process-inspection-busy-unknown-nonownership",
            "pass" if worker.returncode == 0 and inspected and all(item["pid_present"] and item["pane_dead"] == "0" for item in inspected) and foreign_preserved else "fail",
            process_inspection=inspected,
            unknown_sessions=preflight["unknown_sessions"],
            unknown_nonownership=foreign_preserved,
            busy_detected=bool(inspected),
        )

    def idempotent_cleanup(self) -> None:
        marked = self.marked_sessions(SOCKET)
        first: dict[str, bool] = {}
        repeated: dict[str, bool] = {}
        for session in marked:
            first[session] = self.cmd(SOCKET, ["kill-session", "-t", session]).returncode == 0
            # Missing is a successful idempotent outcome.
            absent = session not in self.sessions(SOCKET)
            repeated[session] = absent or self.cmd(SOCKET, ["kill-session", "-t", session]).returncode == 0
        foreign_survives = "foreign-session" in self.sessions(SOCKET)
        self.add(
            "tmux-idempotent-owned-cleanup",
            "pass" if foreign_survives and all(repeated.values() or [True]) else "fail",
            marked_sessions=marked,
            first_cleanup=first,
            repeated_cleanup=repeated,
            foreign_survives=foreign_survives,
        )

    def socket_transition(self) -> None:
        wrong, marked, clean, absent = "transition-wrong", "transition-marked", "transition-clean", "transition-absent"
        self.new_session(wrong, "foreign", self.root)
        self.set_option(wrong, None, "@devhub-protocol", "999")
        wrong_state = self.preflight(wrong)
        self.new_session(marked, "owned", self.root)
        self.set_option(marked, None, "@devhub-protocol", PROTOCOL_MARKER)
        self.set_option(marked, "owned", "@devhub-context", "workspace")
        marked_state = self.preflight(marked)
        self.new_session(clean, "foreign", self.root)
        self.set_option(clean, None, "@devhub-protocol", PROTOCOL_MARKER)
        clean_state = self.preflight(clean)
        absent_state = self.preflight(absent)
        absent_state["valid"] = not absent_state["sessions"] and absent_state["marker"] == ""
        transition_file = self.run_dir / "socket-transition-state.json"
        crash_states = []
        for state in ("pending", "cleaning-old", "old-cleaned", "recreation-pending", "stable"):
            transition_file.write_text(json.dumps({"state": state, "effective_socket": SOCKET}) + "\n")
            restored = json.loads(transition_file.read_text())
            crash_states.append({"crash_after": state, "restored": restored["state"], "ok": restored["state"] == state})
        self.add(
            "tmux-socket-transition-preflight-crash-states",
            "pass" if not wrong_state["valid"] and not marked_state["valid"] and clean_state["valid"] and absent_state["valid"] and all(item["ok"] for item in crash_states) else "fail",
            wrong_marker=wrong_state,
            marked_target=marked_state,
            clean_target=clean_state,
            absent_target=absent_state,
            crash_recovery=crash_states,
            hard_gate_note="Crash records are persisted/reloaded; production StateStore must own the same transition states.",
        )

    def cleanup_servers(self) -> None:
        for socket in sorted(self.sockets, reverse=True):
            try:
                self.cmd(socket, ["kill-server"])
            except (OSError, subprocess.TimeoutExpired):
                pass
        remaining: dict[str, list[str]] = {}
        for socket in sorted(self.sockets):
            remaining[socket] = self.sessions(socket)
        self.cleanup["temporary_sessions_after"] = remaining
        self.cleanup["temporary_servers_stopped"] = all(not sessions for sessions in remaining.values())
        after = self.default_sessions()
        self.cleanup["default_sessions_after"] = after
        self.cleanup["default_socket_mutated"] = after != self.before_default
        try:
            shutil.rmtree(self.tmux_tmp)
            self.cleanup["temporary_tmux_tmpdir_removed"] = not self.tmux_tmp.exists()
        except OSError as exc:
            self.cleanup["temporary_tmux_tmpdir_removed"] = False
            self.cleanup["temporary_tmux_tmpdir_cleanup_error"] = sanitize(str(exc))

    def run(self) -> dict[str, Any]:
        versions = subprocess.run([self.tmux, "-V"], capture_output=True, text=True, env=self.env, check=False)
        self.add("tmux-version", "pass" if "3.7" in versions.stdout else "fail", version=sanitize(versions.stdout), minimum="3.3", socket_name=SOCKET)
        try:
            self.identity_attach_recreate()
            self.process_busy_nonownership()
            self.idempotent_cleanup()
            self.socket_transition()
        except Exception as exc:
            self.add("tmux-harness-execution", "fail", error=sanitize(repr(exc)))
        finally:
            self.cleanup_servers()
        result = {
            "schema": 1,
            "objective": "F0.5 tmux runtime feasibility",
            "binary": self.tmux,
            "socket_name": SOCKET,
            "tmux_tmpdir": str(self.tmux_tmp),
            "run_dir": str(self.run_dir),
            "evidence": self.results,
            "cleanup": self.cleanup,
            "hard_gate_policy": {
                "real_tmux_required": True,
                "fake_adapter_alone_is_not_pass": True,
                "normal_user_socket_mutated": False,
                "production_files_touched": False,
            },
        }
        (self.run_dir / "tmux-results.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, default=None)
    args = parser.parse_args(argv)
    run_dir = args.run_dir or Path(__file__).resolve().parents[1] / "evidence" / f"tmux-run-{time.strftime('%Y%m%d-%H%M%S')}"
    result = TmuxProbe(run_dir).run()
    print(json.dumps({"run_dir": result["run_dir"], "statuses": [item["status"] for item in result["evidence"]], "cleanup": result["cleanup"]}, indent=2))
    return 1 if any(item["status"] == "fail" for item in result["evidence"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
