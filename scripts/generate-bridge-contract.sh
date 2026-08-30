#!/usr/bin/env bash
# Regenerate the bridge extension's contract module from the frozen v1 schema.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node scripts/bridge-contract.ts "$@"
