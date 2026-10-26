#!/bin/sh
# Builds DevHub.app from the SwiftPM package. macOS only.
#
#   Scripts/bundle-app.sh [--debug] [--output DIR] [--bundle-id ID]
#
# Produces DIR/DevHub.app (default DIR: native/build):
#
#   DevHub.app/Contents/Info.plist          from Resources/Info.plist
#   DevHub.app/Contents/MacOS/DevHub        the DevHubApp executable
#   DevHub.app/Contents/Resources/bin/devhub  the CLI (the "Install 'devhub'
#                                           command" action links to this)
#   DevHub.app/Contents/Resources/*.bundle  SwiftPM resource bundles, where
#                                           Bundle.module looks for them
#
# and signs it ad hoc (codesign -s -), which is enough to run it locally and
# from a CI artifact after `xattr -dr com.apple.quarantine`.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
configuration=release
output="$here/build"
bundle_id="net.statiolake.devhub.native"

while [ $# -gt 0 ]; do
	case "$1" in
	--debug) configuration=debug ;;
	--output) output=$2; shift ;;
	--bundle-id) bundle_id=$2; shift ;;
	*) echo "bundle-app.sh: unknown option $1" >&2; exit 2 ;;
	esac
	shift
done

if [ "$(uname -s)" != Darwin ]; then
	echo "bundle-app.sh: DevHub.app can only be built on macOS" >&2
	exit 1
fi

cd "$here"
swift build -c "$configuration" --product DevHubApp
swift build -c "$configuration" --product devhub
bin=$(swift build -c "$configuration" --show-bin-path)

version=$(sed -n 's/.*static let marketing = "\(.*\)".*/\1/p' Sources/DevHubCore/DevHubVersion.swift)
build=$(git rev-list --count HEAD 2>/dev/null || echo 1)

app="$output/DevHub.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/bin"

cp "$bin/DevHubApp" "$app/Contents/MacOS/DevHub"
cp "$bin/devhub" "$app/Contents/Resources/bin/devhub"
for resources in "$bin"/*.bundle "$bin"/*.resources; do
	[ -e "$resources" ] || continue
	cp -R "$resources" "$app/Contents/Resources/"
done
sed -e "s/@VERSION@/$version/" -e "s/@BUILD@/$build/" -e "s/@BUNDLE_IDENTIFIER@/$bundle_id/" \
	Resources/Info.plist >"$app/Contents/Info.plist"
printf 'APPL????' >"$app/Contents/PkgInfo"

plutil -lint "$app/Contents/Info.plist" >/dev/null
codesign --force --sign - --timestamp=none "$app/Contents/Resources/bin/devhub"
codesign --force --sign - --timestamp=none "$app"
codesign --verify --strict "$app"

echo "$app"
