#!/usr/bin/env bash
set -euo pipefail

dist_dir="${1:-apps/devhub/dist}"

if [[ ! -d "$dist_dir" ]]; then
  echo "production app bundle is missing: $dist_dir" >&2
  exit 1
fi

fixture_markers=(
  "visual-fixtures"
  "fixtureSnapshots"
  "renderAppShellFixture"
  "globalSnapshot"
  "workspaceSnapshot"
  "agentSnapshot"
  "unavailableSnapshot"
  "closingFailedSnapshot"
  "settingsFixtureSnapshots"
  "renderSettingsFixture"
  "createSettingsFixtureClient"
  "settings-ready"
  # `settings-dirty` is also the production SettingsApp's semantic dirty-state
  # class. The fixture module is covered by the module marker above and by the
  # other fixture-only route names below, so do not treat this shared class as
  # evidence that development fixture code was bundled.
  "settings-conflict"
  "settings-invalid-diagnostic"
  "settings-socket-confirmation"
)

for marker in "${fixture_markers[@]}"; do
  if rg -n --hidden --fixed-strings "$marker" "$dist_dir" >/dev/null; then
    echo "development fixture marker leaked into production bundle: $marker" >&2
    exit 1
  fi
done

fixture_chunks="$(find "$dist_dir/assets" -type f \( \
  -iname '*fixture*' -o -iname '*route*' -o -iname '*harness*' \
\) -print 2>/dev/null)"
if [[ -n "$fixture_chunks" ]]; then
  echo "development fixture chunk leaked into production bundle:" >&2
  echo "$fixture_chunks" >&2
  exit 1
fi
