#!/bin/zsh

# Finite TIS + CoreGraphics IME smoke. It does not use Accessibility or DOM
# dispatch. The app selects a Japanese input source, posts roman key events to
# its own PID, observes composition/commit, and restores the previous source.
set -euo pipefail

prototype_root="$(cd "$(dirname "$0")/.." && pwd)"
output_file="${F03_NATIVE_IME_OUTPUT:-$prototype_root/evidence/native-ime-smoke-latest.ndjson}"
log_file="$(mktemp -t devhub-f03-native-ime-smoke).log"
app_pid=""
observation_url=""

cleanup() {
  local exit_status=$?
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  print -- "--- native IME smoke runtime log ---" >&2
  sed -n '1,260p' "$log_file" >&2 || true
  print -- "--- native IME smoke output: $output_file ---" >&2
  if [[ -f "$output_file" ]]; then
    sed -n '1,260p' "$output_file" >&2 || true
  fi
  rm -f "$log_file"
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

cd "$prototype_root"
cargo build --offline --quiet
DEVHUB_NATIVE_KEY_ROUTER_IME_TEST=1 \
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
  print "HARD_GATE: IME app did not publish OBSERVATION_URL" >&2
  exit 2
fi

mkdir -p "$(dirname "$output_file")"
for _ in {1..80}; do
  if rg -q 'ime self injection complete composition=nihongo source_restored=true' "$log_file"; then
    break
  fi
  if rg -q 'ime self injection BLOCKED' "$log_file"; then
    break
  fi
  sleep 0.2
done

if ! rg -q 'ime self injection complete composition=nihongo source_restored=true' "$log_file"; then
  print "BLOCKED: TIS Japanese Hiragana selection/composition did not complete" >&2
  exit 3
fi

sleep 1
curl --fail --silent --show-error --max-time 5 "$observation_url" >"$output_file"
for kind in compositionstart compositionend input; do
  if ! rg -q "\"kind\":\"$kind\"" "$output_file"; then
    print "HARD_GATE: child did not observe IME $kind" >&2
    exit 4
  fi
done
if ! rg -q '"kind":"compositionend".*"value":"[^"]*[ぁ-んァ-ン一-龯]' "$output_file"; then
  print "HARD_GATE: composition committed value was not Japanese text" >&2
  exit 5
fi

print "PASS: TIS-selected Japanese IME composition/commit observed and prior source restored"
