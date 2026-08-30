#!/usr/bin/env bash
# Verify the checked-in bridge artifacts still agree with the v1 schema.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node scripts/bridge-contract.ts --check
