#!/usr/bin/env bash
# Per-stage timings of the `devhub` command against a running DevHub: see
# scripts/bench_cli.py (`scripts/bench-cli.sh --help`).
exec python3 "$(dirname "${BASH_SOURCE[0]}")/bench_cli.py" "$@"
