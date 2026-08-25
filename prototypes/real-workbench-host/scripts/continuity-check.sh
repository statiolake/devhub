#!/bin/zsh
# THROWAWAY finite hidden-continuity check. Run while one child is native-hidden.
set -euo pipefail

port="${REAL_WORKBENCH_PORT:-18765}"
duration="${REAL_WORKBENCH_CONTINUITY_SECONDS:-600}"
interval="${REAL_WORKBENCH_CONTINUITY_INTERVAL_SECONDS:-30}"
log_file="${REAL_WORKBENCH_CONTINUITY_LOG:-/private/tmp/real-workbench-host/continuity.log}"
mkdir -p "${log_file:h}"
: > "$log_file"

started="$(date +%s)"
deadline=$((started + duration))
print "THROWAWAY continuity start=$(date -u '+%Y-%m-%dT%H:%M:%SZ') duration=${duration}s interval=${interval}s" | tee -a "$log_file"
while (( $(date +%s) < deadline )); do
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  management="$(lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED 2>/dev/null | awk '/com\.apple/ {count++} END {print count+0}')"
  extension="$(lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED 2>/dev/null | awk '/node/ {count++} END {print count+0}')"
  print "$timestamp com.apple-established=$management node-established=$extension" | tee -a "$log_file"
  (( management >= 3 )) || { print -u2 "management socket count dropped below 3"; exit 1; }
  sleep "$interval"
done
print "THROWAWAY continuity end=$(date -u '+%Y-%m-%dT%H:%M:%SZ') result=PASS" | tee -a "$log_file"
