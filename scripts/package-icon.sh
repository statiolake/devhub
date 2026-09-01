#!/usr/bin/env bash
# Render the icon masters in assets/ into distribution/DevHub.icns.
#
# The .icns is committed rather than produced during packaging, because
# rasterising an SVG on macOS means `qlmanage`, and `qlmanage` needs a window
# server: it is reliable on a developer's Mac and a gamble on a CI runner.
# Packaging must not be a gamble, so the gamble is taken here, by hand, on the
# rare day the icon changes.
#
# Run it after editing either master and commit the result.
#
# Two masters, because an .icns holds a separate image per size and the sizes
# do not want the same drawing. assets/icon-master.svg is the icon; at 16 and
# 32 px it collapses, so those two come from assets/icon-master-small.svg,
# which is the same mark drawn heavier. See the comments in both files.
#
# Two tools, because neither does the whole job. `qlmanage` renders the SVG
# correctly — gradients, filters, arcs — but flattens the result onto opaque
# white, so a rounded icon comes back as a white square with an icon painted in
# it. That is how the previous icon shipped, and it is why the corner radius is
# cut again here as an alpha mask with ImageMagick. The mask is drawn one pixel
# inside the radius the SVG paints, so the cut lands in solid colour instead of
# on the SVG's own antialiased edge and leaves no white fringe behind.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MASTER="$REPO_ROOT/assets/icon-master.svg"
MASTER_SMALL="$REPO_ROOT/assets/icon-master-small.svg"
TARGET="$REPO_ROOT/distribution/DevHub.icns"

# The corner radius of the 1024 grid, and the shape both masters paint.
RADIUS=234

for tool in qlmanage magick iconutil; do
	command -v "$tool" >/dev/null || {
		echo "error: $tool is not on PATH" >&2
		echo "       qlmanage and iconutil ship with macOS; magick is 'brew install imagemagick'" >&2
		exit 1
	}
done

for source in "$MASTER" "$MASTER_SMALL"; do
	[ -f "$source" ] || { echo "error: no icon master at $source" >&2; exit 1; }
done

WORK="$(mktemp -d "$REPO_ROOT/distribution/.icon.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Render a master at 1024 and give it back its transparent corners.
render() {
	local source="$1" out="$2"
	qlmanage -t -s 1024 -o "$WORK" "$source" >/dev/null 2>&1
	local flat="$WORK/$(basename "$source").png"
	[ -f "$flat" ] || { echo "error: qlmanage rendered no thumbnail for $source" >&2; exit 1; }
	magick "$flat" -alpha off \
		\( -size 1024x1024 xc:black -fill white \
		   -draw "roundrectangle 1,1 1022,1022 $((RADIUS - 1)),$((RADIUS - 1))" -alpha off \) \
		-compose CopyOpacity -composite "$out"
}

render "$MASTER" "$WORK/master.png"
render "$MASTER_SMALL" "$WORK/master-small.png"

ICONSET="$WORK/DevHub.iconset"
mkdir -p "$ICONSET"

# `<iconset name> <pixels> <master>`. Everything at 32 px or below is drawn by
# the small master; everything above it by the icon proper.
while read -r name pixels source; do
	magick "$WORK/$source" -resize "${pixels}x${pixels}" "$ICONSET/icon_${name}.png"
done <<-'SIZES'
	16x16       16   master-small.png
	16x16@2x    32   master-small.png
	32x32       32   master-small.png
	32x32@2x    64   master.png
	128x128     128  master.png
	128x128@2x  256  master.png
	256x256     256  master.png
	256x256@2x  512  master.png
	512x512     512  master.png
	512x512@2x  1024 master.png
SIZES

iconutil -c icns "$ICONSET" -o "$TARGET"
echo "wrote $TARGET ($(stat -f%z "$TARGET") bytes)"
