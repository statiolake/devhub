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
# white, so what comes back is a 1024 square with no transparency anywhere.
# That is how the previous icon shipped: a white square with a rounded icon
# painted inside it. So ImageMagick rebuilds here the two things that need an
# alpha channel to exist.
#
# First the tile: the corner radius is cut as a mask, drawn one pixel inside the
# radius the SVG paints so the cut lands in solid colour rather than on the
# SVG's own antialiased edge, and leaves no white fringe behind.
#
# Then the shadow, which cannot be masked back in because a soft shadow over
# white is grey, and grey is also a colour the icon is allowed to contain — the
# render alone cannot say which grey is which. It is synthesised instead, from
# the alpha the mask just produced: blur it, drop it, tint it. Deterministic,
# and it is why the masters draw a shadow that this script then throws away —
# theirs is so the file previews as the icon it is, this one is what ships.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MASTER="$REPO_ROOT/assets/icon-master.svg"
MASTER_SMALL="$REPO_ROOT/assets/icon-master-small.svg"
TARGET="$REPO_ROOT/distribution/DevHub.icns"

# Apple's macOS icon grid, which the masters draw and this script cuts back out:
# an 824 px tile centred on the 1024 px canvas, corner radius 185.4, and a 100 px
# transparent margin holding the shadow. The margin is not spare space — it is
# what keeps DevHub the same size in the Dock as the apps beside it.
TILE_ORIGIN=100
TILE_SIZE=824
TILE_RADIUS=185

# The tile's shadow: straight down, soft, and faint enough to read as depth
# rather than as part of the drawing.
SHADOW_DROP=10
SHADOW_BLUR=10
SHADOW_OPACITY=0.25

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

# Render a master at 1024, cut the tile out of the flattened square, and put the
# tile's shadow back underneath it.
render() {
	local source="$1" out="$2"
	qlmanage -t -s 1024 -o "$WORK" "$source" >/dev/null 2>&1
	local flat="$WORK/$(basename "$source").png"
	[ -f "$flat" ] || { echo "error: qlmanage rendered no thumbnail for $source" >&2; exit 1; }

	# The tile's bounds in pixels, and the same inset by one so the mask's edge
	# falls inside solid colour.
	local x0=$((TILE_ORIGIN + 1)) y0=$((TILE_ORIGIN + 1))
	local x1=$((TILE_ORIGIN + TILE_SIZE - 2)) y1=$((TILE_ORIGIN + TILE_SIZE - 2))

	magick "$flat" -alpha off \
		\( -size 1024x1024 xc:black -fill white \
		   -draw "roundrectangle $x0,$y0 $x1,$y1 $((TILE_RADIUS - 1)),$((TILE_RADIUS - 1))" -alpha off \) \
		-compose CopyOpacity -composite "$WORK/tile.png"

	# Black, shaped like the tile's alpha, blurred and faded.
	magick "$WORK/tile.png" -alpha extract -blur "0x$SHADOW_BLUR" \
		-evaluate multiply "$SHADOW_OPACITY" "$WORK/shadow-alpha.png"
	magick -size 1024x1024 xc:black "$WORK/shadow-alpha.png" -alpha off \
		-compose CopyOpacity -composite "$WORK/shadow.png"

	magick -size 1024x1024 xc:none \
		"$WORK/shadow.png" -geometry "+0+$SHADOW_DROP" -compose Over -composite \
		"$WORK/tile.png" -geometry +0+0 -compose Over -composite "$out"
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
