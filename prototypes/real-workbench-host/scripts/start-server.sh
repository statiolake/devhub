#!/bin/zsh
# THROWAWAY helper: start the pinned OpenVSCode Server artifact on loopback.
# Runtime state is deliberately kept under /private/tmp, never in this repo.
set -euo pipefail

artifact_root="${OPENVSCODE_ARTIFACT_ROOT:-/private/tmp/openvscode-darwin-arm64-feasibility/vscode-reh-web-darwin-arm64}"
runtime_root="${REAL_WORKBENCH_RUNTIME_ROOT:-/private/tmp/real-workbench-host}"
port="${REAL_WORKBENCH_PORT:-18765}"
artifact="${artifact_root}/bin/openvscode-server"
token_file="${runtime_root}/connection-token"

[[ -x "$artifact" ]] || { print -u2 "missing executable: $artifact"; exit 2; }
mkdir -p "$runtime_root" "$runtime_root/server-data" "$runtime_root/user-data"
if [[ ! -e "$token_file" ]]; then
  umask 077
  openssl rand -hex 32 > "$token_file"
fi
chmod 600 "$token_file"
[[ "$(stat -f %Lp "$token_file")" == "600" ]] || {
  print -u2 "token file must be mode 600: $token_file"
  exit 2
}

# The upstream binary prints its authenticated URL, including `tkn=...`, at
# startup. Keep that credential out of terminal logs while preserving the
# server's exit status and Ctrl-C behavior.
set +e
"$artifact" \
  --host 127.0.0.1 \
  --port "$port" \
  --connection-token-file "$token_file" \
  --accept-server-license-terms \
  --server-data-dir "$runtime_root/server-data" \
  --user-data-dir "$runtime_root/user-data" \
  --log error 2>&1 | sed -E 's/(tkn=)[^[:space:]]+/\1<redacted>/g'
server_status=${pipestatus[1]}
set -e
exit "$server_status"
