#!/usr/bin/env bash
# Render assets/icon-master.svg into the app icon the packaged bundle carries.
#
# The .icns is committed (distribution/DevHub.icns) rather than produced during
# packaging, because rasterising an SVG on macOS means `qlmanage`, and
# `qlmanage` needs a window server: it is reliable on a developer's Mac and a
# gamble on a CI runner. Packaging must not be a gamble, so the gamble is taken
# here, by hand, on the rare day the icon changes.
#
# Run it after editing assets/icon-master.svg and commit the result.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO_ROOT/assets/icon-master.svg"
TARGET="$REPO_ROOT/distribution/DevHub.icns"
WORK="$(mktemp -d "$REPO_ROOT/distribution/.icon.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SOURCE" ] || { echo "no icon master at $SOURCE" >&2; exit 1; }

qlmanage -t -s 1024 -o "$WORK" "$SOURCE" >/dev/null
MASTER="$WORK/$(basename "$SOURCE").png"
[ -f "$MASTER" ] || { echo "qlmanage rendered no thumbnail for $SOURCE" >&2; exit 1; }

ICONSET="$WORK/DevHub.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
	sips -z "$size" "$size" "$MASTER" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
	sips -z "$((size * 2))" "$((size * 2))" "$MASTER" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET" -o "$TARGET"
echo "wrote $TARGET ($(stat -f%z "$TARGET") bytes)"
