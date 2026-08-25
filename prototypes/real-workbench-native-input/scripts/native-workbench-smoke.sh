#!/bin/zsh
# Finite real Workbench native shortcut gate. Run on a visible logged-in Mac.
set -euo pipefail

root="${0:A:h:h}"
mode="${1:-normal}"
case "$mode" in
  normal) exec node "$root/scripts/native-workbench-smoke.mjs" ;;
  ime) exec node "$root/scripts/native-workbench-smoke.mjs" --ime ;;
  *) print -u2 "usage: $0 [normal|ime]"; exit 2 ;;
esac
