#!/bin/zsh

# Real-machine macOS smoke test for F0.3. This intentionally uses AppKit's
# accessibility surface to generate user-like key events; it is not a unit
# test and must not be interpreted as IME automation.
set -euo pipefail

prototype_root="$(cd "$(dirname "$0")/.." && pwd)"
output_file="${F03_NATIVE_SMOKE_OUTPUT:-$prototype_root/evidence/native-smoke-latest.ndjson}"
log_file="$(mktemp -t devhub-f03-native-smoke).log"
app_pid=""
observation_url=""

cleanup() {
  local exit_status=$?
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  print -- "--- native smoke runtime log ---" >&2
  sed -n '1,240p' "$log_file" >&2 || true
  print -- "--- native smoke output: $output_file ---" >&2
  if [[ -f "$output_file" ]]; then
    sed -n '1,240p' "$output_file" >&2 || true
  fi
  rm -f "$log_file"
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

cd "$prototype_root"
cargo build --offline --quiet
"$prototype_root/target/debug/devhub-native-key-router" >"$log_file" 2>&1 &
app_pid=$!

for _ in {1..90}; do
  observation_url="$(rg -o 'OBSERVATION_URL=http://[^ ]+' "$log_file" | sed 's/^.*=//' | head -1 || true)"
  if [[ -n "$observation_url" ]]; then
    break
  fi
  sleep 0.2
done

if [[ -z "$observation_url" ]]; then
  print "HARD_GATE: app did not publish OBSERVATION_URL" >&2
  exit 2
fi

mkdir -p "$(dirname "$output_file")"
curl --fail --silent --show-error --max-time 5 "$observation_url" >"$output_file" || true

# System Events is deliberately required to see a real native window. A
# headless/non-AX session must fail here instead of claiming keyboard proof.
if ! F03_NATIVE_SMOKE_PID="$app_pid" osascript <<'APPLESCRIPT'
on run
  set targetPid to (system attribute "F03_NATIVE_SMOKE_PID") as integer
  tell application "System Events"
    set targetProcess to first process whose unix id is targetPid
    tell targetProcess
      set frontmost to true
      delay 0.6
      if (count of windows) is 0 then
        error "AX: native process has no visible window"
      end if
      perform action "AXRaise" of window 1
      delay 0.4

      -- Focus A, then ordinary Command shortcuts.
      key code 18 using {command down}
      delay 0.3
      key code 35 using {command down} -- P
      key code 35 using {command down, shift down} -- Shift-P
      key code 1 using {command down} -- S
      key code 6 using {command down} -- Z
      key code 8 using {command down} -- C
      key code 9 using {command down} -- V

      -- Prefix timeout, unknown key, and defined host routes.
      key code 12 using {command down}
      key code 40 using {command down} -- unmapped Command-K
      key code 12 using {command down}
      key code 43 using {command down} -- Settings
      key code 12 using {command down}
      key code 19 using {command down} -- Focus B while prefix is armed

      -- Exact double-Q must forward one native key equivalent to B.
      key code 12 using {command down}
      delay 0.2
      key code 12 using {command down}

      -- A second Q after 1000ms is not a forward; clear the fresh prefix.
      key code 12 using {command down}
      delay 1.2
      key code 12 using {command down}
      key code 40 using {command down}
    end tell
  end tell
end run
APPLESCRIPT
then
  print "HARD_GATE: System Events could not obtain an AX-visible native window" >&2
  exit 3
fi

sleep 1
curl --fail --silent --show-error --max-time 5 "$observation_url" >"$output_file"

if ! rg -q 'forward native key equivalent .*synthetic_js=false' "$log_file"; then
  print "HARD_GATE: host did not record native Command-Q forwarding" >&2
  exit 4
fi
if ! rg -q '"kind":"keydown".*"key":"q".*"trusted":true' "$output_file"; then
  print "HARD_GATE: child did not observe trusted native Q" >&2
  exit 5
fi
for key in p s z c v; do
  if ! rg -q "\"kind\":\"keydown\".*\"key\":\"$key\".*\"trusted\":true" "$output_file"; then
    print "HARD_GATE: child did not observe trusted Command-$key" >&2
    exit 6
  fi
done

print "PASS: native ordinary shortcuts, exact double-Q forwarding, prefix route/timeout, and trusted child observation"
