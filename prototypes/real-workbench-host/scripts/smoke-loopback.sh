#!/bin/zsh
# THROWAWAY finite smoke test. Never prints the connection token or response body.
set -euo pipefail

runtime_root="${REAL_WORKBENCH_RUNTIME_ROOT:-/private/tmp/real-workbench-host}"
port="${REAL_WORKBENCH_PORT:-18765}"
token_file="${runtime_root}/connection-token"
tmp_root="$(mktemp -d /private/tmp/real-workbench-smoke.XXXXXX)"
trap 'rm -rf "$tmp_root"' EXIT

token="$(tr -d '\n' < "$token_file")"
request() {
  local name="$1" url="$2" expected="$3" code
  code="$(curl --silent --show-error --location --cookie "$tmp_root/$name.cookies" --cookie-jar "$tmp_root/$name.cookies" --output "$tmp_root/$name.html" --write-out '%{http_code}' "$url")"
  [[ "$code" == "$expected" ]] || { print -u2 "$name expected HTTP $expected, got $code"; exit 1; }
  rg -q 'remoteAuthority|workbench' "$tmp_root/$name.html" || {
    print -u2 "$name did not contain Workbench bootstrap markers"
    exit 1
  }
  print "$name HTTP $code"
}

request global "http://127.0.0.1:${port}/?ew=true&tkn=${token}" 200
request folder_one "http://127.0.0.1:${port}/?folder=%2FUsers%2Ftestuser%2Fgithub%2Fvscode&tkn=${token}" 200
request folder_two "http://127.0.0.1:${port}/?folder=%2FUsers%2Ftestuser%2Fgithub%2Fdevhub&tkn=${token}" 200
unauth_code="$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/")"
[[ "$unauth_code" == 403 ]] || { print -u2 "unauthenticated root expected HTTP 403, got $unauth_code"; exit 1; }
print "unauthenticated root HTTP $unauth_code"
