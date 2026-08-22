#!/usr/bin/env bash
set -euo pipefail

cargo run --locked -p devhub-app-core --bin generate_bridge_contract
