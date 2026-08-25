# DevHub app icon

`/assets/icon-master.svg` is the single source of truth for the MVP app icon.
It uses the approved stone, charcoal, and blue palette to show Editor, Agent,
and Terminal panes converging on one provider-neutral hub. It contains no text,
provider mark, or third-party artwork and is designed to remain legible at
16 px.

`devhub.iconset/` contains the complete macOS 1x/2x raster set. `icon.icns` is
the bundle asset referenced by `tauri.conf.json`; `icon.png` is the 1024 px
preview kept beside it for tooling that accepts a single PNG.

The checked-in bundle targets Apple Silicon macOS 15 or later. Signing and
notarization remain release-wave work; this icon asset is safe for the local
ad-hoc-signed MVP bundle.
