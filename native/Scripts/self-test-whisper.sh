#!/bin/sh
# The speech recogniser the self-test's dictation check listens with, for CI:
# whisper.cpp's whisper-cli and whisper-server (as devhub-whisper and
# devhub-whisper-server) and the small English model, in DIR, the layout
# DEVHUB_WHISPER_DIR names (`Whisper.locate`).
#
#   Scripts/self-test-whisper.sh DIR
#
# Pinned and verified as scripts/build_whisper.py pins the bundle's: the
# clone is refused unless the tag names the commit, and the model unless its
# SHA-1 is the one whisper.cpp's own models/README.md lists for it at that
# commit (and the one written here). Built for the CPU (no Metal: CI's Macs
# are virtual machines), statically, so the programs stand alone. A DIR that
# already holds everything (CI's cache) is checked and left as it is.
set -eu

dir=${1:?usage: self-test-whisper.sh DIR}
version=v1.9.4
commit=927cfce34f31707e17f2bff35c349632fb9e2c3a
model=ggml-base.en.bin
model_sha1=137c40403d78fd54d454da0f9bd998f78703390c

sha1() { shasum -a 1 "$1" | cut -d' ' -f1; }

if [ -x "$dir/devhub-whisper" ] && [ -x "$dir/devhub-whisper-server" ] && [ -f "$dir/$model" ] &&
	[ "$(sha1 "$dir/$model")" = "$model_sha1" ]; then
	echo "self-test-whisper: $dir is ready"
	exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" https://github.com/ggml-org/whisper.cpp "$work/src"
head=$(git -C "$work/src" rev-parse HEAD)
if [ "$head" != "$commit" ]; then
	echo "self-test-whisper: $version is $head, not $commit" >&2
	exit 1
fi
listed=$(grep -E "^\| *base\.en *\|" "$work/src/models/README.md" | grep -oE "[0-9a-f]{40}" | head -1 || true)
if [ "$listed" != "$model_sha1" ]; then
	echo "self-test-whisper: models/README.md lists ${listed:-no hash} for $model, not $model_sha1" >&2
	grep -n "base.en" "$work/src/models/README.md" >&2 || true
	exit 1
fi

cmake -S "$work/src" -B "$work/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=OFF \
	-DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF >/dev/null
cmake --build "$work/build" --config Release -j "$(sysctl -n hw.ncpu)" --target whisper-cli whisper-server >/dev/null

mkdir -p "$dir"
cp "$work/build/bin/whisper-cli" "$dir/devhub-whisper"
cp "$work/build/bin/whisper-server" "$dir/devhub-whisper-server"
cp "$work/src/LICENSE" "$dir/LICENSE-whisper.cpp"
if [ ! -f "$dir/$model" ] || [ "$(sha1 "$dir/$model")" != "$model_sha1" ]; then
	curl -fsSL --retry 3 -o "$work/$model" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$model"
	got=$(sha1 "$work/$model")
	if [ "$got" != "$model_sha1" ]; then
		echo "self-test-whisper: $model hashes to $got, not $model_sha1" >&2
		exit 1
	fi
	mv "$work/$model" "$dir/$model"
fi
printf '{"model": "%s", "whisper.cpp": "%s", "commit": "%s"}\n' "$model" "$version" "$commit" >"$dir/whisper.json"
echo "self-test-whisper: $dir has whisper.cpp $version and $model"
