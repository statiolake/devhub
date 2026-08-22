#!/usr/bin/env bash
set -euo pipefail

exec cargo run --locked -p devhub-app-core --bin generate_app_shell_contract -- --check
