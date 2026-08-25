#!/bin/sh
# Exercise the pinned Herdr wire contract and the current DevHub adapter
# against a real isolated 0.8.1 server. The dummy codex/claude commands never
# contact an external service.
set -eu

# DEVHUB_HERDR_BIN is the supported override. HERDR_BIN remains a documented
# compatibility alias for local callers that already use the old name.
HERDR_BIN=${DEVHUB_HERDR_BIN:-${HERDR_BIN:-/opt/homebrew/bin/herdr}}
SESSION_NAME=devhub-session
# Keep the build toolchain's caches outside the provider's isolated HOME. The
# latter is only for Herdr state/configuration and is exposed separately to
# the ignored adapter test.
BUILD_HOME=${HOME:-}
BUILD_CARGO_HOME=${CARGO_HOME:-${BUILD_HOME:+$BUILD_HOME/.cargo}}
[ -n "$BUILD_HOME" ] || {
    echo "HOME must be set for the Cargo build environment" >&2
    exit 2
}
[ -n "$BUILD_CARGO_HOME" ] || {
    echo "CARGO_HOME could not be derived from HOME" >&2
    exit 2
}
# HOME/config/socket/PID-ledger state must live below an owner-only short Q5
# root. q5-native passes an exact per-check parent; standalone runs use the
# same ~/.dhq5 policy. Never fall back to TMPDIR or the system /tmp.
Q5_SECURE_PARENT=${DEVHUB_Q5_SECURE_RUN_ROOT:-$BUILD_HOME/.dhq5}
case "$Q5_SECURE_PARENT" in
    /*) ;;
    *)
        echo "Q5 secure run root must be absolute" >&2
        exit 2
        ;;
esac
[ ! -L "$Q5_SECURE_PARENT" ] || {
    echo "Q5 secure run root must not be a symlink" >&2
    exit 2
}
mkdir -m 700 -p "$Q5_SECURE_PARENT"
[ -d "$Q5_SECURE_PARENT" ] && [ -O "$Q5_SECURE_PARENT" ] || {
    echo "Q5 secure run root must be an owner directory" >&2
    exit 2
}
if mode=$(stat -f '%Lp' "$Q5_SECURE_PARENT" 2>/dev/null); then
    :
else
    mode=$(stat -c '%a' "$Q5_SECURE_PARENT" 2>/dev/null || true)
fi
[ "$mode" = 700 ] || {
    echo "Q5 secure run root must have mode 0700" >&2
    exit 2
}
Q5_SECURE_PARENT=$(cd "$Q5_SECURE_PARENT" && pwd -P)
ROOT=$(mktemp -d "$Q5_SECURE_PARENT/r.XXXXXX")
chmod 700 "$ROOT"
ROOT=$(cd "$ROOT" && pwd -P)
BIN_DIR=$ROOT/bin
HOME_DIR=$ROOT/home
XDG_CONFIG_HOME=$ROOT/config
XDG_STATE_HOME=$ROOT/state
XDG_DATA_HOME=$ROOT/data
HERDR_CONFIG_PATH=$XDG_CONFIG_HOME/herdr/config.toml
API_SOCKET=$XDG_CONFIG_HOME/herdr/sessions/$SESSION_NAME/herdr.sock
CLIENT_SOCKET=$XDG_CONFIG_HOME/herdr/sessions/$SESSION_NAME/herdr-client.sock
api_socket_bytes=$(LC_ALL=C printf '%s' "$API_SOCKET" | wc -c | tr -d '[:space:]')
client_socket_bytes=$(LC_ALL=C printf '%s' "$CLIENT_SOCKET" | wc -c | tr -d '[:space:]')
if [ "$api_socket_bytes" -ge 104 ] || [ "$client_socket_bytes" -ge 104 ]; then
    echo "socket_path_too_long" >&2
    exit 2
fi
WORKSPACE_ROOT=$ROOT/workspace
TRACE_FILE=$ROOT/agent-trace.log
PID_DIR=$ROOT/agent-pids
ADAPTER_PID_FILE=$ROOT/adapter-herdr.pid
SERVER_PID=

stop_pid() {
    pid=$1
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        return 0
    fi
    kill -TERM "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do
        sleep 0.05
        i=$((i + 1))
    done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
}

cleanup() {
    status=$?
    if [ "$status" -ne 0 ]; then
        echo "real Herdr harness failed; isolated server log:" >&2
        sed -n '1,120p' "$ROOT/herdr-server.log" >&2 || true
        echo "deterministic agent trace:" >&2
        sed -n '1,120p' "$TRACE_FILE" >&2 || true
    fi
    stop_pid "${SERVER_PID}"
    if [ -f "$ADAPTER_PID_FILE" ]; then
        stop_pid "$(sed -n '1p' "$ADAPTER_PID_FILE")"
    fi
    for pid_file in "$PID_DIR"/*.pid; do
        [ -f "$pid_file" ] || continue
        stop_pid "$(sed -n '1p' "$pid_file")"
    done
    case "$ROOT" in
        "$Q5_SECURE_PARENT"/r.*) rm -rf "$ROOT" ;;
        *)
            echo "refusing to remove an unowned Q5 run root" >&2
            status=1
            ;;
    esac
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$BIN_DIR" "$HOME_DIR" "$XDG_CONFIG_HOME/herdr" "$XDG_STATE_HOME" \
    "$XDG_DATA_HOME" "$WORKSPACE_ROOT" "$PID_DIR"
printf '[update]\nversion_check = false\nmanifest_check = false\n' >"$HERDR_CONFIG_PATH"
# Compile one self-contained local helper, then copy it under each provider
# basename. A real executable name lets Herdr's process detector report the
# deterministic child as codex/claude instead of an opaque shell wrapper.
cat >"$ROOT/deterministic-agent.c" <<'EOF'
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t stopping = 0;
static char pid_path[4096];
static const char *kind = NULL;

static void stop_handler(int signal_number) {
    (void)signal_number;
    stopping = 1;
}

static const char *basename_of(const char *path) {
    const char *slash = strrchr(path, '/');
    return slash == NULL ? path : slash + 1;
}

static int contains_exit_marker(const char *line) {
    return strstr(line, "DEVHUB_HERDR_HARNESS_EXIT") != NULL;
}

int main(int argc, char **argv) {
    const char *trace_path = getenv("DEVHUB_HERDR_TRACE_FILE");
    const char *pid_dir = getenv("DEVHUB_HERDR_PID_DIR");
    const char *argv_kind = basename_of(argv[0]);
    FILE *trace = NULL;
    FILE *pid = NULL;
    char line[4096];

    if (strcmp(argv_kind, "codex") != 0 && strcmp(argv_kind, "claude") != 0) {
        argv_kind = getenv("DEVHUB_HERDR_HARNESS_KIND");
    }
    if (argv_kind == NULL || (strcmp(argv_kind, "codex") != 0 && strcmp(argv_kind, "claude") != 0)
        || trace_path == NULL || pid_dir == NULL) {
        return 2;
    }
    kind = argv_kind;
    (void)snprintf(pid_path, sizeof(pid_path), "%s/%s.%ld.pid", pid_dir, kind, (long)getpid());

    pid = fopen(pid_path, "w");
    if (pid == NULL) {
        return 3;
    }
    (void)fprintf(pid, "%ld\n", (long)getpid());
    (void)fclose(pid);

    trace = fopen(trace_path, "a");
    if (trace == NULL) {
        (void)unlink(pid_path);
        return 4;
    }
    (void)fprintf(trace, "kind=%s args=", kind);
    for (int index = 1; index < argc; ++index) {
        if (index > 1) {
            (void)fputc(' ', trace);
        }
        (void)fputs(argv[index], trace);
    }
    (void)fputc('\n', trace);
    (void)fprintf(trace, "env HERDR_AGENT=%s DEVHUB_HERDR_HARNESS=%s DEVHUB_HERDR_HARNESS_KIND=%s PATH=%s\n",
                  getenv("HERDR_AGENT") == NULL ? "" : getenv("HERDR_AGENT"),
                  getenv("DEVHUB_HERDR_HARNESS") == NULL ? "" : getenv("DEVHUB_HERDR_HARNESS"),
                  getenv("DEVHUB_HERDR_HARNESS_KIND") == NULL ? "" : getenv("DEVHUB_HERDR_HARNESS_KIND"),
                  getenv("PATH") == NULL ? "" : getenv("PATH"));
    (void)fflush(trace);
    (void)fclose(trace);

    (void)signal(SIGTERM, stop_handler);
    (void)signal(SIGINT, stop_handler);
    (void)signal(SIGHUP, stop_handler);
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (strcmp(kind, "codex") == 0) {
        (void)fputs("\033]0;DevHub Harness\007", stdout);
    } else {
        (void)fputs("\033]0;\342\234\263 DevHub Harness\007", stdout);
    }
    (void)printf("DEVHUB_HERDR_%s_READY\n", strcmp(kind, "codex") == 0 ? "CODEX" : "CLAUDE");

    while (!stopping && fgets(line, sizeof(line), stdin) != NULL) {
        if (contains_exit_marker(line)) {
            (void)printf("DEVHUB_HERDR_%s_EXITING\n", strcmp(kind, "codex") == 0 ? "CODEX" : "CLAUDE");
            break;
        }
        (void)printf("DEVHUB_HERDR_%s_INPUT:%s", strcmp(kind, "codex") == 0 ? "CODEX" : "CLAUDE", line);
        if (strchr(line, '\n') == NULL) {
            (void)fputc('\n', stdout);
        }
    }
    (void)unlink(pid_path);
    return 0;
}
EOF
if command -v clang >/dev/null 2>&1; then
    CC_BIN=clang
elif command -v cc >/dev/null 2>&1; then
    CC_BIN=cc
else
    echo "clang or cc is required to build deterministic agent helper" >&2
    exit 2
fi
"$CC_BIN" -std=c11 -O2 -Wall -Wextra -Werror -o "$BIN_DIR/deterministic-agent" \
    "$ROOT/deterministic-agent.c"
cp "$BIN_DIR/deterministic-agent" "$BIN_DIR/codex"
cp "$BIN_DIR/deterministic-agent" "$BIN_DIR/claude"
chmod 700 "$BIN_DIR/deterministic-agent" "$BIN_DIR/codex" "$BIN_DIR/claude"
# Herdr starts the workspace's interactive shell before `agent.start` sends
# the command.  zsh/bash startup files may rebuild PATH, so pin the fake-agent
# directory in each isolated shell startup file as well as in the workspace
# launch environment.
printf 'export PATH="%s"\n' "$BIN_DIR:/opt/homebrew/bin:/usr/bin:/bin" >"$HOME_DIR/.zshenv"
cp "$HOME_DIR/.zshenv" "$HOME_DIR/.zprofile"
cp "$HOME_DIR/.zshenv" "$HOME_DIR/.zshrc"
cp "$HOME_DIR/.zshenv" "$HOME_DIR/.bash_profile"
cp "$HOME_DIR/.zshenv" "$HOME_DIR/.bashrc"
chmod 600 "$HOME_DIR/.zshenv" "$HOME_DIR/.zprofile" "$HOME_DIR/.zshrc" \
    "$HOME_DIR/.bash_profile" "$HOME_DIR/.bashrc"

version=$(
    HOME="$HOME_DIR" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" XDG_STATE_HOME="$XDG_STATE_HOME" \
        XDG_DATA_HOME="$XDG_DATA_HOME" HERDR_CONFIG_PATH="$HERDR_CONFIG_PATH" \
        PATH="$BIN_DIR:/opt/homebrew/bin:/usr/bin:/bin" \
        "$HERDR_BIN" --version
)
[ "$version" = "herdr 0.8.1" ] || {
    echo "expected herdr 0.8.1, got an incompatible binary" >&2
    exit 2
}

start_server() {
    HOME="$HOME_DIR" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" XDG_STATE_HOME="$XDG_STATE_HOME" \
        XDG_DATA_HOME="$XDG_DATA_HOME" HERDR_CONFIG_PATH="$HERDR_CONFIG_PATH" \
        PATH="$BIN_DIR:/opt/homebrew/bin:/usr/bin:/bin" \
        "$HERDR_BIN" --session "$SESSION_NAME" server >"$ROOT/herdr-server.log" 2>&1 &
    SERVER_PID=$!
    i=0
    while [ "$i" -lt 100 ]; do
        if [ -S "$API_SOCKET" ] && [ -S "$CLIENT_SOCKET" ]; then
            return 0
        fi
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            cat "$ROOT/herdr-server.log" >&2 || true
            return 1
        fi
        sleep 0.05
        i=$((i + 1))
    done
    echo "timed out waiting for isolated Herdr sockets" >&2
    cat "$ROOT/herdr-server.log" >&2 || true
    return 1
}

start_server

export XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME HERDR_CONFIG_PATH
export PATH="$BIN_DIR:/opt/homebrew/bin:/usr/bin:/bin"
export DEVHUB_HERDR_HOME="$HOME_DIR"
export HOME="$BUILD_HOME"
export CARGO_HOME="$BUILD_CARGO_HOME"
export DEVHUB_HERDR_AGENT_PATH="$BIN_DIR:/opt/homebrew/bin:/usr/bin:/bin"
export DEVHUB_HERDR_BIN="$HERDR_BIN"
export DEVHUB_HERDR_API_SOCKET="$API_SOCKET"
export DEVHUB_HERDR_CLIENT_SOCKET="$CLIENT_SOCKET"
export DEVHUB_HERDR_WORKSPACE_ROOT="$WORKSPACE_ROOT"
export DEVHUB_HERDR_SERVER_PID="$SERVER_PID"
export DEVHUB_HERDR_TRACE_FILE="$TRACE_FILE"
export DEVHUB_HERDR_PID_DIR="$PID_DIR"
export DEVHUB_HERDR_ADAPTER_PID_FILE="$ADAPTER_PID_FILE"

HERDR_API_SOCKET="$API_SOCKET" HERDR_CLIENT_SOCKET="$CLIENT_SOCKET" \
    API_SOCKET="$API_SOCKET" CLIENT_SOCKET="$CLIENT_SOCKET" WORKSPACE_ROOT="$WORKSPACE_ROOT" \
    python3 - <<'PY'
import json
import os
import socket
import struct
import time

api_path = os.environ["API_SOCKET"]
client_path = os.environ["CLIENT_SOCKET"]
workspace_root = os.environ["WORKSPACE_ROOT"]


def line_response(sock):
    data = bytearray()
    while not data.endswith(b"\n"):
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("Herdr API closed before a response")
        data.extend(chunk)
        if len(data) > 512 * 1024:
            raise RuntimeError("Herdr API response exceeded bound")
    return json.loads(data)


def call(method, params, allow_error=False):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(api_path)
        sock.sendall((json.dumps({"id": method, "method": method, "params": params}) + "\n").encode())
        response = line_response(sock)
    if "error" in response:
        if allow_error:
            return None
        raise RuntimeError(f"{method} returned an error")
    return response["result"]


def recv_exact(sock, size):
    data = bytearray()
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise RuntimeError("Herdr control socket closed")
        data.extend(chunk)
    return bytes(data)


def recv_frame(sock):
    length = struct.unpack("<I", recv_exact(sock, 4))[0]
    if length > 2 * 1024 * 1024:
        raise RuntimeError("Herdr control frame exceeded bound")
    return recv_exact(sock, length)


def varint(value):
    if value < 251:
        return bytes([value])
    if value <= 0xFFFF:
        return b"\xfb" + struct.pack("<H", value)
    if value <= 0xFFFFFFFF:
        return b"\xfc" + struct.pack("<I", value)
    return b"\xfd" + struct.pack("<Q", value)


def frame(payload):
    return struct.pack("<I", len(payload)) + payload


def control(terminal_id, takeover):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(5)
    sock.connect(client_path)
    hello = varint(0) + varint(20) + varint(80) + varint(24) + varint(0) + varint(0) + varint(1) + varint(0) + varint(2)
    sock.sendall(frame(hello))
    welcome = recv_frame(sock)
    if welcome != bytes([0, 20, 1, 0]):
        raise RuntimeError("Herdr protocol-20 welcome mismatch")
    target = terminal_id.encode()
    request = varint(9) + varint(len(target)) + target + bytes([1 if takeover else 0])
    sock.sendall(frame(request))
    return sock, recv_frame(sock)


def wait_for_pane_marker(pane_id, marker):
    deadline = time.monotonic() + 5.0
    while True:
        recent = call("pane.read", {"pane_id": pane_id, "source": "recent", "lines": 100})
        if marker in recent["read"]["text"]:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(f"agent did not emit {marker} before timeout")
        time.sleep(0.1)


ping = call("ping", {})
assert ping["version"] == "0.8.1" and ping["protocol"] == 20
snapshot = call("session.snapshot", {})
assert snapshot["snapshot"]["version"] == "0.8.1"

created = call("workspace.create", {"cwd": workspace_root, "focus": False, "label": "devhub-agent-real-codex", "env": {"DEVHUB_REAL": "1", "DEVHUB_HERDR_TRACE_FILE": os.environ["DEVHUB_HERDR_TRACE_FILE"], "DEVHUB_HERDR_PID_DIR": os.environ["DEVHUB_HERDR_PID_DIR"], "HERDR_AGENT": "codex", "PATH": os.environ["DEVHUB_HERDR_AGENT_PATH"]}})
workspace_id = created["workspace"]["workspace_id"]
pane_id = created["root_pane"]["pane_id"]

started = call("agent.start", {"name": "acodexreal", "kind": "codex", "pane_id": pane_id, "args": ["--deterministic"], "timeout_ms": 5000})
terminal_id = started["agent"]["terminal_id"]
assert started["agent"]["name"] == "acodexreal"
assert call("agent.list", {})["agents"]
wait_for_pane_marker(pane_id, "DEVHUB_HERDR_CODEX_READY")

subscription = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
subscription.settimeout(5)
subscription.connect(api_path)
subscription.sendall((json.dumps({"id": "status", "method": "events.subscribe", "params": {"subscriptions": [{"type": "pane.agent_status_changed", "pane_id": pane_id}]}}) + "\n").encode())
assert line_response(subscription)["result"]["type"] == "subscription_started"
subscription.close()

first, first_terminal = control(terminal_id, False)
assert first_terminal[0] == 2
second, second_message = control(terminal_id, False)
assert second_message[0] == 4, "a live owner must reject a second non-takeover handle"
second.close()
takeover, takeover_terminal = control(terminal_id, True)
assert takeover_terminal[0] == 2
first.close()
takeover.sendall(frame(varint(4)))
takeover.close()

# The short-lived deterministic command naturally exits; status remains
# observable before the owned workspace is explicitly closed.
time.sleep(1.5)
call("agent.get", {"target": "acodexreal"})
call("pane.close", {"pane_id": pane_id})
call("workspace.close", {"workspace_id": workspace_id}, allow_error=True)

created = call("workspace.create", {"cwd": workspace_root, "focus": False, "label": "devhub-agent-real-claude", "env": {"DEVHUB_REAL": "1", "DEVHUB_HERDR_TRACE_FILE": os.environ["DEVHUB_HERDR_TRACE_FILE"], "DEVHUB_HERDR_PID_DIR": os.environ["DEVHUB_HERDR_PID_DIR"], "HERDR_AGENT": "claude", "PATH": os.environ["DEVHUB_HERDR_AGENT_PATH"]}})
workspace_id = created["workspace"]["workspace_id"]
pane_id = created["root_pane"]["pane_id"]
started = call("agent.start", {"name": "aclaudereal", "kind": "claude", "pane_id": pane_id, "args": ["--deterministic"], "timeout_ms": 5000})
wait_for_pane_marker(pane_id, "DEVHUB_HERDR_CLAUDE_READY")
call("agent.get", {"target": "aclaudereal"})
call("pane.close", {"pane_id": pane_id})
call("workspace.close", {"workspace_id": workspace_id}, allow_error=True)

print("real Herdr 0.8.1 API/control lifecycle passed")
PY

# Run the adapter's pinned probes against the same real sockets. These are
# ignored in ordinary unit runs because they require an external provider.
DEVHUB_HERDR_API_SOCKET="$API_SOCKET" DEVHUB_HERDR_CLIENT_SOCKET="$CLIENT_SOCKET" \
    cargo test --offline --locked -p devhub-app --lib agent::api::tests::pinned_herdr_transport_checks_all_mutation_prerequisites -- --ignored --exact
DEVHUB_HERDR_API_SOCKET="$API_SOCKET" DEVHUB_HERDR_CLIENT_SOCKET="$CLIENT_SOCKET" \
    cargo test --offline --locked -p devhub-app --lib agent::control::tests::pinned_herdr_control_socket_accepts_protocol_twenty_handshake -- --ignored --exact

# This is the lifecycle acceptance: it calls the current HerdrAgentRuntime,
# not only the raw wire protocol. The test also crashes the initial server;
# the adapter starts the fixed named session again and the runner cleanup
# reaps the replacement PID recorded by the test.
cargo test --offline --locked -p devhub-app --lib agent::real_harness::real_herdr_agent_runtime_lifecycle -- --ignored --exact --nocapture
