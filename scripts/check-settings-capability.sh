#!/usr/bin/env bash
set -euo pipefail

settings_capability="apps/devhub/src-tauri/capabilities/settings.json"
shell_capability="apps/devhub/src-tauri/capabilities/app-shell.json"

rg -q '"webviews": \["settings"\]' "$settings_capability"
rg -q 'allow-get-settings-snapshot' "$settings_capability"
rg -q 'allow-save-settings' "$settings_capability"
rg -q 'allow-reload-settings' "$settings_capability"
rg -q 'allow-recheck-settings' "$settings_capability"
rg -q 'allow-open-log-folder' "$settings_capability"
rg -q 'allow-apply-socket-change' "$settings_capability"
rg -q '"webviews": \["app-shell"\]' "$shell_capability"
rg -q 'allow-get-app-appearance' "$shell_capability"

if rg -n '"windows"' "$settings_capability" "$shell_capability" >/dev/null; then
  echo "Capability scope must be webview-only; windows scope is forbidden" >&2
  exit 1
fi

if rg -n 'settings|allow-(get|save|reload|recheck|open-log|apply-socket)-settings|socket-change' "$shell_capability" >/dev/null; then
  echo "Settings permission leaked into app-shell capability" >&2
  exit 1
fi

echo "Settings capability scope is valid"
