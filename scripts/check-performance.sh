#!/usr/bin/env bash
set -euo pipefail

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$root_dir"

python3 scripts/q5-performance.py --check --report docs/evidence/q5.2-local-report.json
python3 scripts/q5-performance.py --self-test
