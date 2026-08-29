#!/usr/bin/env bash
# Rebuild the vendored WRY fork from a pristine crates.io release plus the
# DevHub patch series.
#
# The fork exists for five narrow hooks, all recorded in
# apps/devhub/src-tauri/vendor/wry/DEVHUB-PATCH.md. Keeping them as a patch
# against a named release is what makes a Tauri upgrade tractable: bump
# WRY_VERSION, run this, and resolve rejects against the new source rather
# than re-deriving the changes from a diverged tree.
#
#   scripts/revendor-wry.sh              # rebuild at the pinned version
#   WRY_VERSION=0.56.0 scripts/revendor-wry.sh
#
# Regenerating the series after editing the fork directly:
#   scripts/revendor-wry.sh --record
set -euo pipefail

WRY_VERSION="${WRY_VERSION:-0.55.1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/apps/devhub/src-tauri/vendor/wry"
PATCH="$ROOT/apps/devhub/src-tauri/vendor/wry-devhub.patch"

PRISTINE=""
for candidate in "$HOME"/.cargo/registry/src/*/"wry-$WRY_VERSION"; do
  [ -d "$candidate" ] && PRISTINE="$candidate" && break
done
if [ -z "$PRISTINE" ]; then
  echo "wry $WRY_VERSION is not in the cargo registry cache." >&2
  echo "Run 'cargo fetch' with that version pinned, then try again." >&2
  exit 1
fi

# Every file the series touches. Recorded here rather than derived, so a patch
# that stops applying is a visible failure instead of a silently skipped hook.
FILES=(
  src/lib.rs
  src/webkitgtk/mod.rs
  src/webview2/mod.rs
  src/wkwebview/mod.rs
  src/wkwebview/navigation.rs
  src/wkwebview/class/wry_web_view.rs
  src/wkwebview/class/wry_web_view_parent.rs
)

if [ "${1:-}" = "--record" ]; then
  : > "$PATCH"
  for file in "${FILES[@]}"; do
    /usr/bin/diff -u --label "a/$file" --label "b/$file" \
      "$PRISTINE/$file" "$VENDOR/$file" >> "$PATCH" || true
  done
  echo "recorded $(grep -c '^--- a/' "$PATCH") files into ${PATCH#"$ROOT"/}"
  exit 0
fi

# DevHub-owned files that are not part of upstream and must survive the copy.
KEEP="$(mktemp -d)"
trap 'rm -rf "$KEEP"' EXIT
for extra in DEVHUB-PATCH.md; do
  [ -e "$VENDOR/$extra" ] && cp -R "$VENDOR/$extra" "$KEEP/"
done
find "$VENDOR" -name .claude -maxdepth 4 -print0 2>/dev/null |
  while IFS= read -r -d '' guard; do
    relative="${guard#"$VENDOR"/}"
    mkdir -p "$KEEP/guards/$(dirname "$relative")"
    cp -R "$guard" "$KEEP/guards/$relative"
  done

rm -rf "$VENDOR"
mkdir -p "$VENDOR"
# Packaging metadata, upstream tooling, and a nested .gitignore/rustfmt.toml
# that would quietly change how this repository treats the subtree. None of it
# is source, and the original vendoring left all of it out.
(cd "$PRISTINE" && tar cf - \
  --exclude .cargo --exclude .cargo-ok --exclude .cargo_vcs_info.json \
  --exclude .gitignore --exclude .license_template --exclude Cargo.lock \
  --exclude SECURITY.md --exclude renovate.json --exclude rustfmt.toml \
  --exclude ./examples .) | (cd "$VENDOR" && tar xf -)

for extra in DEVHUB-PATCH.md; do
  [ -e "$KEEP/$extra" ] && cp -R "$KEEP/$extra" "$VENDOR/"
done
if [ -d "$KEEP/guards" ]; then
  (cd "$KEEP/guards" && tar cf - .) | (cd "$VENDOR" && tar xf -)
fi

patch -p1 -d "$VENDOR" < "$PATCH"
echo "vendored wry $WRY_VERSION with $(grep -c '^--- a/' "$PATCH") patched files"
