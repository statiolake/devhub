#!/bin/zsh
# THROWAWAY helper: run the native three-child host against a local server.
set -euo pipefail

prototype_root="${0:A:h:h}"
runtime_root="${REAL_WORKBENCH_RUNTIME_ROOT:-/private/tmp/real-workbench-host}"
port="${REAL_WORKBENCH_PORT:-18765}"
token_file="${runtime_root}/connection-token"

[[ -r "$token_file" ]] || { print -u2 "missing token file: $token_file"; exit 2; }
token="$(tr -d '\n' < "$token_file")"
[[ -n "$token" ]] || { print -u2 "empty token file"; exit 2; }

folder_one="${REAL_WORKBENCH_FOLDER_ONE_PATH:-~/path/to/vscode}"
folder_two="${REAL_WORKBENCH_FOLDER_TWO_PATH:-~/path/to/devhub}"
encode_query_value() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}
folder_one_query="$(encode_query_value "$folder_one")"
folder_two_query="$(encode_query_value "$folder_two")"

export REAL_WORKBENCH_GLOBAL_URL="http://127.0.0.1:${port}/?ew=true&tkn=${token}"
export REAL_WORKBENCH_FOLDER_ONE_URL="http://127.0.0.1:${port}/?folder=${folder_one_query}&tkn=${token}"
export REAL_WORKBENCH_FOLDER_TWO_URL="http://127.0.0.1:${port}/?folder=${folder_two_query}&tkn=${token}"
export REAL_WORKBENCH_SHARED_DATA_ROOT="${REAL_WORKBENCH_SHARED_DATA_ROOT:-${runtime_root}/shared-webkit-data}"

exec cargo run --manifest-path "$prototype_root/Cargo.toml" "$@"
