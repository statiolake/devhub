#!/usr/bin/env bash
# The chaos layer of the visual-stability suite (docs/visual-stability.md) on this machine: on
# Linux under its own Xvfb (xvfb-run), elsewhere on the display there is.
# Arguments go to chaos.mjs (--seeds 1,2 --rates 1,6 --minutes 25 --replay plan.json).
# Needs a built apps/desktop (`pnpm --filter @devhub/desktop build`); on Linux
# Xvfb, xauth and xdotool (scripts/test-local.sh provision installs them).
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$APP_DIR"
if [ "$(uname -s)" = Linux ] && [ -z "${DEVHUB_STABILITY_DISPLAY:-}" ]; then
	# One screen larger than the window, so it is never cut by the screen.
	exec xvfb-run -a -s "-screen 0 1600x1000x24 -nolisten tcp" node test/stability/chaos.mjs "$@"
fi
[ -n "${DEVHUB_STABILITY_DISPLAY:-}" ] && export DISPLAY="$DEVHUB_STABILITY_DISPLAY"
exec node test/stability/chaos.mjs "$@"
