#!/bin/zsh

# Finite self-injection smoke test. Unlike native-smoke.sh, this script never
# asks System Events to enumerate or raise a window. The app focuses its own
# NSWindow/child NSView and posts CoreGraphics keyboard events to its own PID.
set -euo pipefail

prototype_root="$(cd "$(dirname "$0")/.." && pwd)"
output_file="${F03_NATIVE_SELF_OUTPUT:-$prototype_root/evidence/native-self-smoke-latest.ndjson}"
log_file="$(mktemp -t devhub-f03-native-self-smoke).log"
app_pid=""
observation_url=""

cleanup() {
  local exit_status=$?
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  print -- "--- native self smoke runtime log ---" >&2
  sed -n '1,320p' "$log_file" >&2 || true
  print -- "--- native self smoke output: $output_file ---" >&2
  if [[ -f "$output_file" ]]; then
    sed -n '1,320p' "$output_file" >&2 || true
  fi
  rm -f "$log_file"
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

cd "$prototype_root"
cargo build --offline --quiet
DEVHUB_NATIVE_KEY_ROUTER_SELF_TEST=1 \
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
  print "HARD_GATE: self-injection app did not publish OBSERVATION_URL" >&2
  exit 2
fi

mkdir -p "$(dirname "$output_file")"
for _ in {1..80}; do
  if rg -q 'self injection complete source=CGEventPostToPid' "$log_file"; then
    break
  fi
  sleep 0.2
done

if ! rg -q 'self injection complete source=CGEventPostToPid' "$log_file"; then
  print "HARD_GATE: bounded CGEvent self-injection sequence did not complete" >&2
  exit 3
fi

sleep 1
curl --fail --silent --show-error --max-time 5 "$observation_url" >"$output_file"

if ! rg -q 'self injection posted source=CGEventPostToPid key=cmd-p' "$log_file"; then
  print "HARD_GATE: host did not create/post CGEvent command-P" >&2
  exit 4
fi
if ! rg -q 'forward native key equivalent .*target=child-b.*synthetic_js=false' "$log_file"; then
  print "HARD_GATE: host did not route double-Q natively to active child B" >&2
  exit 5
fi
if ! rg -q 'route host command=settings' "$log_file" || ! rg -q 'route host command=focus target=child-b' "$log_file"; then
  print "HARD_GATE: defined prefix host routes were not observed" >&2
  exit 6
fi

for key in p s z c v k; do
  if ! rg -q "\"kind\":\"keydown\".*\"key\":\"$key\".*\"trusted\":true" "$output_file"; then
    print "HARD_GATE: child did not observe trusted CGEvent key=$key" >&2
    exit 7
  fi
done

q_count="$(rg -c '"kind":"keydown".*"key":"q".*"trusted":true' "$output_file" || true)"
if [[ "$q_count" != "1" ]]; then
  print "HARD_GATE: expected exactly one trusted child Q from double-Q, observed $q_count" >&2
  exit 8
fi

print "PASS: CGEventPostToPid self-injection reached child as trusted DOM events and native double-Q routing was observed"
